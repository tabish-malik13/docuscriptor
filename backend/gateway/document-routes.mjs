import {
  docxSchema, docxType, pdfType, readArtifact, readUpload, sendAttachment, uploadSchema, validateRuntimeValues,
} from '../shared/document-http.mjs'
import { InputError } from '../shared/http-service.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'
import { problem } from '../../shared/problems.mjs'
import { adminRoles } from './tenant-authority.mjs'

const idSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const paramsSchema = { type: 'object', required: ['id'], properties: { id: idSchema } }
const generationSchema = {
  ...docxSchema,
  properties: { ...docxSchema.properties, savedTemplateId: idSchema },
  oneOf: [
    { required: ['templateId'], not: { anyOf: ['file', 'filename', 'savedTemplateId'].map((key) => ({ required: [key] })) } },
    { required: ['file', 'filename'], not: { anyOf: ['templateId', 'savedTemplateId'].map((key) => ({ required: [key] })) } },
    { required: ['savedTemplateId'], not: { anyOf: ['file', 'filename', 'templateId'].map((key) => ({ required: [key] })) } },
  ],
}
const starterNames = { invoice: 'Invoice', letter: 'Business letter', brief: 'Project brief' }
const outputName = (source, kind) => source.replace(/\.[^.]+$/, '').slice(0, 200) + '.' + kind.toLowerCase()

export function registerDocumentRoutes(app, { store, auth, docxService, pdfService, docxSecret, pdfSecret, fetchImpl = fetch, processingLimit = 4 }) {
  const scoped = (request) => store.forRequest ? store.forRequest(request) : store
  let active = 0
  async function processing(work) {
    if (active >= processingLimit) throw problem(503, 'The workspace is busy. Try again shortly.')
    active++
    try { return await work() } finally { active-- }
  }
  async function callService(subject, tenantId, audience, path, payload) {
    try {
      const response = await fetchImpl((audience === 'docx' ? docxService : pdfService) + path, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(28_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: signServiceRequest(audience === 'docx' ? docxSecret : pdfSecret, audience, subject, path, payload, tenantId),
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        // Read bounded JSON too: a misbehaving upstream must not exhaust the gateway.
        const bytes = await readArtifact(response)
        if (response.status === 422) {
          let message
          try { message = JSON.parse(bytes.toString('utf8')).message } catch { /* use generic message */ }
          throw new InputError(typeof message === 'string' ? message.slice(0, 500) : 'The source document could not be processed.')
        }
        throw problem(502, 'The processing service could not complete the request.')
      }
      return response
    } catch (error) {
      if (error instanceof InputError || error.publicMessage) throw error
      throw problem(error.name === 'TimeoutError' ? 504 : 502, 'The processing service is temporarily unavailable.')
    }
  }
  async function generate(request, reply, kind, payload, source) {
    return processing(async () => {
      const name = outputName(source, kind)
      const id = await scoped(request).beginJob(request.tenantId, { name, kind, source, createdBy: request.subject })
      try {
        const response = await callService(request.subject, request.tenantId, kind === 'DOCX' ? 'docx' : 'pdf', kind === 'DOCX' ? '/generate' : '/convert', payload)
        const type = kind === 'DOCX' ? docxType : pdfType
        const bytes = await readArtifact(response)
        if (response.headers.get('content-type')?.split(';')[0] !== type ||
          !(kind === 'DOCX' ? bytes.subarray(0, 2).equals(Buffer.from('PK')) : bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))) {
          throw problem(502, 'The processing service returned an invalid document.')
        }
        await auth.recheckProcessing(request)
        await scoped(request).completeJob(request.tenantId, id, bytes)
        reply.header('X-Document-Id', id)
        return sendAttachment(reply, bytes, type, name)
      } catch (error) {
        try { await scoped(request).failJob(request.tenantId, id, error instanceof InputError ? error.message : error.publicMessage || 'Document processing failed. Submit the document again.') } catch { /* Revocation can also deny cleanup. The reservation stays charged until deletion. */ }
        throw error
      }
    })
  }
  const read = { onRequest: auth.requireTenant }
  const write = { onRequest: auth.requireProcessing, config: { rateLimit: { max: 20 } } }
  app.post('/api/docx/generate', { ...write, schema: { body: generationSchema } }, async (request, reply) => {
    let payload = request.body
    validateRuntimeValues(payload.values)
    let source = starterNames[payload.templateId] || payload.filename
    if (payload.savedTemplateId) {
      const saved = await scoped(request).template(request.tenantId, payload.savedTemplateId)
      if (!saved) throw problem(404, 'Template not found.')
      payload = { filename: 'template.docx', file: Buffer.from(saved.file).toString('base64'), values: payload.values }
      source = saved.name
    }
    if (payload.file) readUpload(payload.file)
    return generate(request, reply, 'DOCX', payload, source)
  })
  app.post('/api/pdf/convert', { ...write, schema: { body: uploadSchema } }, async (request, reply) => {
    readUpload(request.body.file)
    return generate(request, reply, 'PDF', request.body, request.body.filename)
  })
  app.get('/api/jobs', { ...read, schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,4})$' } },
  } } }, async (request) => {
    const offset = Number(request.query.offset || 0)
    const items = await scoped(request).listJobs(request.tenantId, offset)
    return { items, nextOffset: items.length === 50 ? offset + 50 : null }
  })
  app.get('/api/jobs/:id', { ...read, schema: { params: paramsSchema } }, async (request) => {
    const job = await scoped(request).job(request.tenantId, request.params.id)
    if (!job) throw problem(404, 'Document not found.')
    return job
  })
  app.get('/api/jobs/:id/download', { ...read, schema: { params: paramsSchema } }, async (request, reply) => {
    const artifact = await scoped(request).artifact(request.tenantId, request.params.id)
    if (!artifact) throw problem(404, 'Document not found or not ready.')
    return sendAttachment(reply, Buffer.from(artifact.artifact), artifact.kind === 'DOCX' ? docxType : pdfType, artifact.name)
  })
  app.delete('/api/jobs/:id', { ...write, schema: { params: paramsSchema } }, async (request, reply) => {
    const job = await scoped(request).job(request.tenantId, request.params.id)
    if (job && job.createdBy !== request.subject && !adminRoles.has(request.tenantRole)) throw problem(403, 'Only the creator or a tenant administrator can delete this document.')
    if (!await scoped(request).deleteJob(request.tenantId, request.params.id)) throw problem(404, 'Document not found.')
    return reply.code(204).send()
  })
  app.get('/api/templates', read, async (request) => ({ items: await scoped(request).listTemplates(request.tenantId) }))
  app.post('/api/templates', { ...write, schema: { body: {
    ...uploadSchema, required: ['name', 'filename', 'file'],
    properties: { ...uploadSchema.properties, name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } },
  } } }, async (request, reply) => processing(async () => {
    const { filename, file, name } = request.body
    const bytes = readUpload(file)
    const response = await callService(request.subject, request.tenantId, 'docx', '/inspect', { filename, file })
    let metadata
    try { metadata = JSON.parse((await readArtifact(response)).toString('utf8')) } catch {
      throw problem(502, 'The template service returned invalid fields.')
    }
    if (!Array.isArray(metadata.fields) || metadata.fields.length > 64 || metadata.fields.some((field) => typeof field !== 'string')) {
      throw problem(502, 'The template service returned invalid fields.')
    }
    await auth.recheckProcessing(request)
    const saved = await scoped(request).saveTemplate(request.tenantId, name.trim(), metadata.fields, bytes, request.subject)
    return reply.code(201).send(saved)
  }))
  app.get('/api/templates/:id/download', { ...read, schema: { params: paramsSchema } }, async (request, reply) => {
    const saved = await scoped(request).template(request.tenantId, request.params.id)
    if (!saved) throw problem(404, 'Template not found.')
    return sendAttachment(reply, Buffer.from(saved.file), docxType, saved.name + '.docx')
  })
  app.delete('/api/templates/:id', { ...write, schema: { params: paramsSchema } }, async (request, reply) => {
    const saved = await scoped(request).template(request.tenantId, request.params.id)
    if (saved && saved.createdBy !== request.subject && !adminRoles.has(request.tenantRole)) throw problem(403, 'Only the creator or a tenant administrator can delete this template.')
    if (!await scoped(request).deleteTemplate(request.tenantId, request.params.id)) throw problem(404, 'Template not found.')
    return reply.code(204).send()
  })
}
