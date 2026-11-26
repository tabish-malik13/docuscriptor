import {
  docxSchema, docxType, pdfType, readArtifact, readUpload, sendAttachment, uploadSchema,
} from '../shared/document-http.mjs'
import { InputError } from '../shared/http-service.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'
import { problem } from './store.mjs'
import { adminRoles } from './tenant-authority.mjs'
import { organizationTemplateEditScope } from './client-credentials.mjs'
import { documentFilename } from '../../shared/document-filename.mjs'
import { starterLayouts } from '../../shared/starter-layouts.mjs'
import { registerBatchRoutes, requireClientScope } from './batch-routes.mjs'

const idSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const versionNumber = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const templateName = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }
const paramsSchema = { type: 'object', required: ['id'], properties: { id: idSchema } }
const generationSchema = {
  ...docxSchema,
  properties: { ...docxSchema.properties, savedTemplateId: idSchema, savedTemplateVersion: versionNumber },
  dependencies: { savedTemplateVersion: ['savedTemplateId'] },
  oneOf: [
    { required: ['templateId'], not: { anyOf: ['file', 'filename', 'savedTemplateId'].map((key) => ({ required: [key] })) } },
    { required: ['file', 'filename'], not: { anyOf: ['templateId', 'savedTemplateId'].map((key) => ({ required: [key] })) } },
    { required: ['savedTemplateId'], not: { anyOf: ['file', 'filename', 'templateId'].map((key) => ({ required: [key] })) } },
  ],
}

export function registerDocumentRoutes(app, { store, auth, features, docxService, pdfService, docxSecret, pdfSecret, fetchImpl = fetch,
  tenantConcurrency = Number(process.env.TENANT_PROCESSING_CONCURRENCY ?? 2) }) {
  if (!Number.isInteger(tenantConcurrency) || tenantConcurrency < 1 || tenantConcurrency > 4) {
    throw new Error('TENANT_PROCESSING_CONCURRENCY must be an integer between 1 and 4.')
  }
  let active = 0
  const activeByTenant = new Map()
  async function processing(tenantId, reply, work) {
    const tenantActive = activeByTenant.get(tenantId) || 0
    if (tenantActive >= tenantConcurrency || active >= 4) {
      reply.header('Retry-After', '2')
      if (tenantActive >= tenantConcurrency) throw problem(429, 'Your organization is already processing its maximum number of documents.')
      throw problem(503, 'The workspace is busy. Try again shortly.')
    }
    active++
    activeByTenant.set(tenantId, tenantActive + 1)
    try { return await work() } finally {
      active--
      const remaining = activeByTenant.get(tenantId) - 1
      if (remaining) activeByTenant.set(tenantId, remaining)
      else activeByTenant.delete(tenantId)
    }
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
  async function render(request, kind, payload, servicePath = kind === 'DOCX' ? '/generate' : '/convert') {
    const word = kind === 'DOCX'
    const response = await callService(request.subject, request.tenantId, word ? 'docx' : 'pdf', servicePath, payload)
    const bytes = await readArtifact(response)
    const type = word ? docxType : pdfType
    const signature = Buffer.from(word ? 'PK' : '%PDF-')
    if (response.headers.get('content-type')?.split(';')[0] !== type || !bytes.subarray(0, signature.length).equals(signature)) {
      throw problem(502, 'The processing service returned an invalid document.')
    }
    return bytes
  }
  async function finishJob(request, id, produce) {
    try {
      const bytes = await produce()
      await auth.recheckProcessing(request)
      store.completeJob(request.tenantId, id, bytes)
      return bytes
    } catch (error) {
      store.failJob(request.tenantId, id, error instanceof InputError ? error.message : error.publicMessage || 'Document processing failed. Submit the document again.')
      throw error
    }
  }
  function templateSource(request, reply, { templateId, savedTemplateId, savedTemplateVersion }) {
    if (savedTemplateId) {
      requireClientScope(request, reply, 'templates:read')
      const saved = store.template(request.tenantId, savedTemplateId, null, savedTemplateVersion)
      if (!saved) throw problem(404, 'Template not found.')
      return { name: saved.name, fields: JSON.parse(saved.fields), file: saved.file, version: saved.version }
    }
    const layout = starterLayouts[templateId]
    return { name: layout.name, fields: layout.lines.map(([, field]) => field), templateId }
  }
  function templatePayload(source, values) {
    if (!source.file) return { templateId: source.templateId, values }
    return { filename: 'template.docx', file: Buffer.from(source.file).toString('base64'), values }
  }
  async function generate(request, reply, kind, payload, source) {
    return processing(request.tenantId, reply, async () => {
      const name = documentFilename(source, kind)
      const id = store.beginJob(request.tenantId, { name, kind, source, createdBy: request.subject })
      const bytes = await finishJob(request, id, () => render(request, kind, payload))
      reply.header('X-Document-Id', id)
      return sendAttachment(reply, bytes, kind === 'DOCX' ? docxType : pdfType, name)
    })
  }
  const access = (scope) => ({ onRequest: auth.documentAccess(scope) })
  // Uploads can finish after permissions change. Check again before dispatching or modifying a record.
  const mutate = (scope) => ({ ...access(scope), preHandler: auth.recheckProcessing })
  function wordInput(request, reply) {
    const payload = request.body
    if (payload.file) {
      readUpload(payload.file)
      return { payload, name: payload.filename }
    }
    const source = templateSource(request, reply, payload)
    return { payload: templatePayload(source, payload.values), name: source.name }
  }
  const wordRoute = { ...mutate('documents:generate'), schema: { body: generationSchema } }
  app.post('/api/docx/generate', wordRoute, async (request, reply) => {
    const { payload, name } = wordInput(request, reply)
    return generate(request, reply, 'DOCX', payload, name)
  })
  if (features.livePreview) app.post('/api/docx/preview', { ...wordRoute, config: { rateClass: 'preview', rateLimit: { max: 60 } } }, async (request, reply) => {
    return processing(request.tenantId, reply, async () => {
      const { payload } = wordInput(request, reply)
      const bytes = await render(request, 'DOCX', payload, '/preview')
      await auth.recheckProcessing(request)
      return reply.type(docxType).send(bytes)
    })
  })
  app.post('/api/pdf/convert', { ...mutate('documents:convert'), schema: { body: uploadSchema } }, async (request, reply) => {
    readUpload(request.body.file)
    return generate(request, reply, 'PDF', request.body, request.body.filename)
  })
  if (features.batches) registerBatchRoutes(app, { store, auth, processing, render, finishJob, templateSource, templatePayload })
  app.get('/api/jobs', { ...access('documents:read'), schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,4})$' } },
  } } }, async (request) => {
    const offset = Number(request.query.offset || 0)
    const pageSize = 50
    const rows = store.listJobs(request.tenantId, offset, pageSize + 1)
    return { items: rows.slice(0, pageSize), nextOffset: rows.length > pageSize ? offset + pageSize : null }
  })
  app.get('/api/jobs/:id', { ...access('documents:read'), schema: { params: paramsSchema } }, async (request) => {
    const job = store.job(request.tenantId, request.params.id)
    if (!job) throw problem(404, 'Document not found.')
    return job
  })
  app.get('/api/jobs/:id/download', { onRequest: auth.documentDownload, schema: { params: paramsSchema } }, async (request, reply) => {
    if (request.clientScopes && !request.clientScopes.includes('documents:read')) {
      const job = store.job(request.tenantId, request.params.id)
      const requiredScope = job?.kind === 'PDF' ? 'documents:convert' : 'documents:generate'
      if (job?.createdBy !== request.subject || !request.clientScopes.includes(requiredScope)) {
        throw problem(404, 'Document not found or not ready.')
      }
    }
    const artifact = store.artifact(request.tenantId, request.params.id)
    if (!artifact) throw problem(404, 'Document not found or not ready.')
    return sendAttachment(reply, Buffer.from(artifact.artifact), artifact.kind === 'DOCX' ? docxType : pdfType, artifact.name)
  })
  app.delete('/api/jobs/:id', { ...mutate('documents:delete'), schema: { params: paramsSchema } }, async (request, reply) => {
    const job = store.job(request.tenantId, request.params.id)
    if (job && job.createdBy !== request.subject && !adminRoles.has(request.tenantRole)) throw problem(403, 'Only the creator or a tenant administrator can delete this document.')
    if (!store.deleteJob(request.tenantId, request.params.id)) throw problem(404, 'Document not found.')
    return reply.code(204).send()
  })
  app.get('/api/templates', access('templates:read'), async (request) => ({ items: store.listTemplates(request.tenantId) }))
  app.get('/api/templates/mine', { onRequest: auth.requireTenant }, async (request) => ({
    items: store.listTemplates(request.tenantId, request.subject),
  }))
  function templateInfo(request) {
    const saved = store.templateInfo(request.tenantId, request.params.id)
    if (!saved) throw problem(404, 'Template not found.')
    return saved
  }
  app.get('/api/templates/:id', { ...access('templates:read'), schema: { params: paramsSchema } }, async (request) => templateInfo(request))
  async function inspectUpload(request) {
    const { filename, file } = request.body
    const bytes = readUpload(file)
    const response = await callService(request.subject, request.tenantId, 'docx', '/inspect', { filename, file })
    let metadata
    try { metadata = JSON.parse((await readArtifact(response)).toString('utf8')) } catch {
      throw problem(502, 'The template service returned invalid fields.')
    }
    if (!Array.isArray(metadata?.fields) || metadata.fields.length > 64 || metadata.fields.some((field) => typeof field !== 'string')) {
      throw problem(502, 'The template service returned invalid fields.')
    }
    await auth.recheckProcessing(request)
    return { fields: metadata.fields, bytes }
  }
  app.post('/api/templates', { ...mutate('templates:write'), schema: { body: {
    ...uploadSchema, required: ['name', 'filename', 'file'],
    properties: { ...uploadSchema.properties, name: templateName },
  } } }, async (request, reply) => processing(request.tenantId, reply, async () => {
    const { fields, bytes } = await inspectUpload(request)
    const saved = store.saveTemplate(request.tenantId, request.body.name.trim(), fields, bytes, request.subject)
    return reply.code(201).send(saved)
  }))
  function requireTemplateAccess(request, action) {
    const saved = templateInfo(request)
    if (saved.createdBy === request.subject || adminRoles.has(request.tenantRole)) return saved
    if (action === 'edit' && features.templateApiEdits && request.clientScopes?.includes(organizationTemplateEditScope)) return saved
    throw problem(403, 'You do not have permission to ' + action + ' this template.')
  }
  const templateEdit = { onRequest: auth.templateEdit, preHandler: auth.recheckProcessing }
  function editTemplate(request, reply) {
    const { id } = request.params
    const { baseVersion, name, file } = request.body
    const head = requireTemplateAccess(request, 'edit')
    if (head.version !== baseVersion) throw problem(409, 'This template has a newer version. Reopen it before saving another version.')
    if (!file) return store.reviseTemplate(request.tenantId, id, baseVersion, null, null, request.subject, name.trim())
    return processing(request.tenantId, reply, async () => {
      const { fields, bytes } = await inspectUpload(request)
      // Inspection rechecks the caller's role. Apply it to this template before committing.
      requireTemplateAccess(request, 'edit')
      return store.reviseTemplate(request.tenantId, id, baseVersion, fields, bytes, request.subject, name?.trim())
    })
  }
  if (features.templateApiEdits) app.patch('/api/templates/:id', { ...templateEdit, schema: {
    params: paramsSchema, body: { ...uploadSchema, required: ['baseVersion'],
      properties: { ...uploadSchema.properties, baseVersion: versionNumber, name: templateName },
      anyOf: [{ required: ['name'] }, { required: ['file'] }],
      dependencies: { file: ['filename'], filename: ['file'] } },
  } }, async (request, reply) => editTemplate(request, reply))
  if (features.templateVersions) app.post('/api/templates/:id/versions', { ...templateEdit, schema: {
    params: paramsSchema, body: { ...uploadSchema, required: ['baseVersion','filename','file'],
      properties: { ...uploadSchema.properties, baseVersion: versionNumber } },
  } }, async (request, reply) => {
    const saved = await editTemplate(request, reply)
    return reply.code(201).send(saved)
  })
  if (features.templateVersions) app.get('/api/templates/:id/versions', { ...access('templates:read'), schema: { params: paramsSchema } }, async (request) => {
    const items = store.templateVersions(request.tenantId, request.params.id)
    if (!items.length) throw problem(404, 'Template not found.')
    return { items }
  })
  function downloadTemplate(request, reply, creator, version = null) {
    const saved = store.template(request.tenantId, request.params.id, creator, version)
    if (!saved) throw problem(404, 'Template not found.')
    reply.header('X-Template-Version', String(saved.version))
    return sendAttachment(reply, Buffer.from(saved.file), docxType, documentFilename(saved.name, 'DOCX'))
  }
  if (features.templateVersions) app.get('/api/templates/:id/versions/:version/download', { ...access('templates:read'), schema: { params: {
    ...paramsSchema, required: ['id','version'], properties: { id: idSchema, version: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
  } } }, async (request, reply) => {
    const version = Number(request.params.version)
    if (!Number.isSafeInteger(version)) throw problem(400, 'Choose a valid template version.')
    return downloadTemplate(request, reply, null, version)
  })
  app.get('/api/templates/:id/download', { ...access('templates:read'), schema: { params: paramsSchema } },
    async (request, reply) => downloadTemplate(request, reply, null))
  app.get('/api/templates/mine/:id/download', { onRequest: auth.requireTenant, schema: { params: paramsSchema } },
    async (request, reply) => downloadTemplate(request, reply, request.subject))
  if (features.templateDeletion) app.delete('/api/templates/:id', { ...mutate('templates:delete'), schema: { params: paramsSchema } }, async (request, reply) => {
    requireTemplateAccess(request, 'delete')
    if (!store.deleteTemplate(request.tenantId, request.params.id)) throw problem(404, 'Template not found.')
    return reply.code(204).send()
  })
}
