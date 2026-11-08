import Docxtemplater from 'docxtemplater'
import inspectModule from 'docxtemplater/js/inspect-module.js'
import PizZip from 'pizzip'
import { docxSchema, docxType, maxOutputBytes, readUpload, sendAttachment } from '../shared/document-http.mjs'
import { createService, InputError, start } from '../shared/http-service.mjs'
import { validateWordFile } from '../shared/word-file.mjs'
import { starterTemplate } from './starter-templates.mjs'

const app = createService()
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

app.get('/health', async () => ({ status: 'ok' }))
app.post('/generate', { schema: { body: docxSchema } }, async (request, reply) => {
  const { filename, file, templateId, values } = request.body
  let source
  if (templateId) {
    source = await starterTemplate(templateId)
  } else {
    if (!filename.toLowerCase().endsWith('.docx')) throw new InputError('Choose a Word template with a .docx extension.')
    source = readUpload(file)
    await validateWordFile(source)
  }
  let output
  try {
    const inspector = inspectModule()
    const document = new Docxtemplater(new PizZip(source), {
      modules: [inspector], linebreaks: true, errorLogging: false,
    })
    const tags = inspector.getAllStructuredTags()
    if (tags.length > 1024) throw new InputError('The template exceeds the 1,024 placeholder limit.')
    let estimatedValueBytes = 0
    for (const tag of tags) {
      if (tag.module || !fieldName.test(tag.value)) {
        throw new InputError('Use simple text fields such as {customer_name} in this workflow.')
      }
      if (!Object.hasOwn(values, tag.value)) throw new InputError('Provide a value for {' + tag.value + '}.')
      estimatedValueBytes += Buffer.byteLength(values[tag.value]) * 6
    }
    if (estimatedValueBytes > maxOutputBytes) throw new InputError('The expanded template exceeds the output limit.')
    document.render(values)
    output = document.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('Check that the template has valid Word content and balanced placeholders.')
  }
  if (output.length > maxOutputBytes) throw new InputError('The generated file exceeds the 16 MB output limit.')
  return sendAttachment(reply, output, docxType, 'document.docx')
})

await start(app, Number(process.env.PORT || 4001))
