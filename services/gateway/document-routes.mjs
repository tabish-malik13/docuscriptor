import {
  docxSchema, docxType, pdfType, readArtifact, readUpload, sendAttachment, uploadSchema,
} from '../shared/document-http.mjs'
import { InputError } from '../shared/http-service.mjs'
import { validateWordFile } from '../shared/word-file.mjs'
import { authorizeDocumentProcessing } from './authorize-document-processing.mjs'

const docxService = process.env.DOCX_SERVICE_URL || 'http://127.0.0.1:4001'
const pdfService = process.env.PDF_SERVICE_URL || 'http://127.0.0.1:4002'

async function processWith(reply, url, options, artifact) {
  let result
  try {
    result = await fetch(url, { ...options, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(28_000) })
    if (artifact.type === docxType && result.status === 422) {
      const problem = await result.json()
      return reply.code(422).send({ message: problem.message || 'The Word template could not be processed.' })
    }
    if (!result.ok) {
      await result.body?.cancel()
      if (artifact.type === pdfType && [400, 422].includes(result.status)) {
        return reply.code(422).send({ message: 'The converter could not read this file.' })
      }
      return reply.code(502).send({ message: 'The processing service could not complete the request.' })
    }
    const bytes = await readArtifact(result)
    if (!bytes.length) return reply.code(502).send({ message: 'The processing service returned an empty file.' })
    return sendAttachment(reply, bytes, artifact.type, artifact.name)
  } catch (error) {
    if (error instanceof InputError) throw error
    return reply.code(error.name === 'TimeoutError' ? 504 : 502).send({ message: 'The processing service is temporarily unavailable.' })
  }
}

export function registerDocumentRoutes(app) {
  app.post('/api/docx/generate', {
    onRequest: authorizeDocumentProcessing, config: { rateLimit: {} }, schema: { body: docxSchema },
  }, (request, reply) => processWith(reply, docxService + '/generate', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body),
  }, { type: docxType, name: 'document.docx' }))

  app.post('/api/pdf/convert', {
    onRequest: authorizeDocumentProcessing, config: { rateLimit: {} }, schema: { body: uploadSchema },
  }, async (request, reply) => {
    const { filename, file } = request.body
    const bytes = readUpload(file)
    const extension = filename.toLowerCase().split('.').at(-1)
    const form = new FormData()
    let route
    if (extension === 'docx') {
      await validateWordFile(bytes)
      form.append('files', new Blob([bytes], { type: docxType }), 'document.docx')
      route = '/forms/libreoffice/convert'
    } else if (extension === 'html' || extension === 'htm') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new InputError('Save the HTML file as UTF-8 and upload it again.')
      }
      form.append('files', new Blob([bytes], { type: 'text/html; charset=utf-8' }), 'index.html')
      form.append('printBackground', 'true')
      form.append('preferCssPageSize', 'true')
      route = '/forms/chromium/convert/html'
    } else {
      throw new InputError('Choose a DOCX or HTML file to convert.')
    }
    return processWith(reply, pdfService + route, { body: form }, { type: pdfType, name: 'document.pdf' })
  })
}
