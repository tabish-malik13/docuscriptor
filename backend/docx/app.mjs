import { docxSchema, docxType, maxOutputBytes, readUpload, sendAttachment, uploadSchema } from '../shared/document-http.mjs'
import { createService, InputError } from '../shared/http-service.mjs'
import { serviceAuthorization } from '../shared/service-authorization.mjs'
import { validateWordFile } from '../shared/word-file.mjs'
import { starterTemplate } from './starter-templates.mjs'
import { inspectTemplate } from './template.mjs'

export function buildDocxApp({ secret = process.env.DOCX_SERVICE_SECRET, logger } = {}) {
  const authorize = serviceAuthorization(secret, 'docx')
  const app = createService({ logger })
  app.decorateRequest('subject', null)
  app.decorateRequest('tenantId', null)
  app.get('/health', async () => ({ status: 'ok' }))
  async function sourceFile(filename, file) {
    if (!filename.toLowerCase().endsWith('.docx')) throw new InputError('Choose a Word template with a .docx extension.')
    const source = readUpload(file)
    await validateWordFile(source)
    return source
  }
  app.post('/inspect', { preValidation: authorize, schema: { body: uploadSchema } }, async (request) => {
    const { fields } = inspectTemplate(await sourceFile(request.body.filename, request.body.file))
    return { fields }
  })
  async function render(request, reply, preview) {
    const { filename, file, templateId, values } = request.body
    const source = templateId ? await starterTemplate(templateId) : await sourceFile(filename, file)
    const { document, tags, fields } = inspectTemplate(source)
    const replacements = Object.create(null)
    for (const field of fields) {
      const supplied = Object.hasOwn(values, field)
      if (!preview && !supplied) throw new InputError('Provide a value for {' + field + '}.')
      replacements[field] = supplied ? values[field] : '{' + field + '}'
    }
    const expanded = tags.reduce((total, tag) => total + Buffer.byteLength(replacements[tag.value]) * 6, 0)
    if (expanded > maxOutputBytes) throw new InputError('The expanded template exceeds the output limit.')
    let output
    try {
      document.render(replacements)
      output = document.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
    } catch {
      throw new InputError('The Word template could not be processed.')
    }
    if (output.length > maxOutputBytes) throw new InputError('The generated file exceeds the 16 MB output limit.')
    return sendAttachment(reply, output, docxType, 'document.docx')
  }
  const route = { preValidation: authorize, schema: { body: docxSchema } }
  app.post('/generate', route, (request, reply) => render(request, reply, false))
  app.post('/preview', route, (request, reply) => render(request, reply, true))
  return app
}
