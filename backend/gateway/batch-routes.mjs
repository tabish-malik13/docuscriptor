import PizZip from 'pizzip'
import { batchFilenames } from '../../shared/batch-filenames.mjs'
import { certificateRosterIssues } from '../../shared/certificate-roster.mjs'
import { docxSchema, maxFileBytes, sendAttachment } from '../shared/document-http.mjs'
import { InputError } from '../shared/http-service.mjs'
import { problem } from './store.mjs'
import { uuidPattern } from './tenant-authority.mjs'

const id = { type: 'string', format: 'uuid' }
const params = { type: 'object', required: ['id'], additionalProperties: false, properties: { id } }
const maxArchiveBytes = 32 * 1024 * 1024
const createSchema = {
  type: 'object', required: ['format', 'rows'], additionalProperties: false,
  oneOf: [{ required: ['templateId'] }, { required: ['savedTemplateId'] }],
  properties: {
    templateId: docxSchema.properties.templateId, savedTemplateId: id,
    format: { type: 'string', enum: ['DOCX', 'PDF'] },
    rows: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', required: ['name', 'values'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
        values: docxSchema.properties.values,
      },
    } },
  },
}

export function requireClientScope(request, reply, scope) {
  if (request.clientScopes && !request.clientScopes.includes(scope)) {
    reply.header('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="' + scope + '"')
    throw problem(403, 'This operation requires ' + scope + '.')
  }
}

function validateRows(rows, fields) {
  const allowed = new Set(fields)
  for (const [index, { values }] of rows.entries()) {
    const missing = fields.find(field => !Object.hasOwn(values, field))
    if (missing) throw problem(422, 'Row ' + (index + 1) + ' needs a value for {' + missing + '}.')
    const extra = Object.keys(values).find(field => !allowed.has(field))
    if (extra) throw problem(422, 'Row ' + (index + 1) + ' contains an unmapped field {' + extra + '}.')
  }
}

export function registerBatchRoutes(app, { store, auth, processing, render, finishJob, templateSource, templatePayload }) {
  const access = { onRequest: auth.documentAccess('documents:generate') }
  const mutation = { ...access, preHandler: auth.recheckProcessing }
  function requireFormat(request, reply, format) {
    if (format === 'PDF') requireClientScope(request, reply, 'documents:convert')
  }
  function load(request, reply) {
    const batch = store.batch(request.tenantId, request.subject, request.params.id)
    if (!batch) throw problem(404, 'Batch not found.')
    requireFormat(request, reply, batch.format)
    return batch
  }
  app.post('/api/batches', { ...mutation, bodyLimit: 2 * 1024 * 1024, schema: { body: createSchema } }, async (request, reply) => {
    const { rows, format, templateId, savedTemplateId } = request.body
    requireFormat(request, reply, format)
    if (savedTemplateId) requireClientScope(request, reply, 'templates:read')
    const key = request.headers['idempotency-key']
    if (key !== undefined && (typeof key !== 'string' || !uuidPattern.test(key))) {
      throw problem(400, 'Use a UUID as the Idempotency-Key.')
    }
    const names = batchFilenames(rows.map(row => row.name), format)
    const input = { templateId, savedTemplateId, format, idempotencyKey: key?.toLowerCase(),
      rows: rows.map((row, index) => ({ name: names[index], values: row.values })) }
    if (key) {
      const previous = store.batchByKey(request.tenantId, request.subject, input)
      if (previous) return reply.code(201).send(previous)
    }
    const source = templateSource(request, reply, input)
    validateRows(rows, source.fields)
    if (templateId === 'certificate') {
      const [issue] = certificateRosterIssues(rows)
      if (issue) throw problem(422, issue)
    }
    return reply.code(201).send(store.createBatch(request.tenantId, request.subject, {
      ...input, templateName: source.name, savedTemplateVersion: source.version,
    }))
  })
  app.get('/api/batches', access, async (request) => {
    let items = store.listBatches(request.tenantId, request.subject)
    if (request.clientScopes && !request.clientScopes.includes('documents:convert')) items = items.filter(item => item.format !== 'PDF')
    return { items }
  })
  app.get('/api/batches/:id', { ...access, schema: { params } }, async (request, reply) => load(request, reply))
  app.post('/api/batches/:id/next', { ...mutation, schema: { params, querystring: {
    type: 'object', additionalProperties: false, properties: { row: { type: 'string', pattern: '^([1-9][0-9]?|100)$' } },
  } } }, async (request, reply) => {
    const batch = load(request, reply)
    const expected = request.query.row ? Number(request.query.row) : undefined
    if (expected && expected > batch.total) throw problem(400, 'This batch does not contain the requested row.')
    if (expected && batch.rows[expected - 1].status !== 'pending') return batch
    if (!batch.pending && !batch.processing) return batch
    if (batch.savedTemplateId) requireClientScope(request, reply, 'templates:read')
    return processing(request.tenantId, reply, async () => {
      const source = templateSource(request, reply, batch)
      const row = store.claimBatchRow(request.tenantId, request.subject, batch.id, expected)
      if (row) {
        try {
          await finishJob(request, row.jobId, async () => {
            const word = await render(request, 'DOCX', templatePayload(source, row.values))
            if (batch.format === 'DOCX') return word
            if (word.length > maxFileBytes) throw new InputError('The generated Word document exceeds the 4 MB PDF input limit.')
            await auth.recheckProcessing(request)
            return render(request, 'PDF', { filename: 'generated.docx', file: word.toString('base64') })
          })
        } catch (error) {
          // A bad source row is terminal and visible in the report. Authorization and service
          // failures stop the caller so a prolonged outage cannot consume the remaining roster.
          if (!(error instanceof InputError)) throw error
          await auth.recheckProcessing(request)
        }
      }
      return load(request, reply)
    })
  })
  app.get('/api/batches/:id/download', { ...access, schema: { params } }, async (request, reply) => {
    const batch = load(request, reply)
    return processing(request.tenantId, reply, async () => {
      const ready = batch.rows.filter(row => row.available)
      if (!ready.length) throw problem(409, 'No completed files are available to download.')
      if (ready.reduce((sum, row) => sum + row.size, 0) > maxArchiveBytes) {
        throw problem(409, 'The completed files exceed the 32 MiB archive limit. Download individual files from the run.')
      }
      const archive = new PizZip()
      // Rows and their artifacts are read synchronously from the same single-gateway store.
      for (const row of ready) {
        const file = store.artifact(request.tenantId, row.jobId)
        if (!file || file.createdBy !== request.subject) throw problem(409, 'A saved file is unavailable. Refresh the run.')
        archive.file(row.name, file.artifact, { createFolders: false })
      }
      const bytes = archive.generate({ type: 'nodebuffer', compression: 'STORE' })
      await auth.recheckProcessing(request)
      reply.header('X-Batch-File-Count', String(ready.length))
      reply.header('X-Batch-Omitted-Count', String(batch.total - ready.length))
      return sendAttachment(reply, bytes, 'application/zip', 'documents-' + batch.id + '.zip')
    })
  })
  app.delete('/api/batches/:id', { ...mutation, schema: { params } }, async (request, reply) => {
    const batch = load(request, reply)
    store.deleteBatch(request.tenantId, request.subject, batch.id)
    return reply.code(204).send()
  })
}
