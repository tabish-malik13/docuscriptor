import { docxSchema, docxType, maxOutputBytes, readUpload, sendAttachment, uploadSchema, validateRuntimeValues } from '../shared/document-http.mjs'
import { createService, InputError } from '../shared/http-service.mjs'
import { serviceAuthorization } from '../shared/service-authorization.mjs'
import { validateWordFile } from '../shared/word-file.mjs'
import { starterTemplate } from './starter-templates.mjs'
import { createTemplate, inspectTemplate, validateTemplateData } from './template.mjs'

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
  app.post('/generate', { preValidation: authorize, schema: { body: docxSchema } }, async (request, reply) => {
    const { filename, file, templateId, values } = request.body
    validateRuntimeValues(values)
    const source = templateId ? await starterTemplate(templateId) : await sourceFile(filename, file)
    const { tags } = inspectTemplate(source)
    validateTemplateData(tags, values)
    const document = createTemplate(source)
    let output
    try {
      document.render(values)
      output = document.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
    } catch {
      throw new InputError('The Word template could not be processed.')
    }
    if (output.length > maxOutputBytes) throw new InputError('The generated file exceeds the 16 MB output limit.')
    return sendAttachment(reply, output, docxType, 'document.docx')
  })
  return app
}
