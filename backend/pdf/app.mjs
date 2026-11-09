import { docxType, pdfType, readArtifact, readUpload, sendAttachment, uploadSchema } from '../shared/document-http.mjs'
import { createService, InputError } from '../shared/http-service.mjs'
import { requireSecret, serviceAuthorization } from '../shared/service-authorization.mjs'
import { validateWordFile } from '../shared/word-file.mjs'

export function buildPdfApp({
  secret = process.env.PDF_SERVICE_SECRET,
  rendererUrl = process.env.GOTENBERG_URL || 'http://127.0.0.1:3000',
  rendererPassword = process.env.GOTENBERG_PASSWORD,
  fetchImpl = fetch, logger,
} = {}) {
  const authorize = serviceAuthorization(secret, 'pdf')
  requireSecret(rendererPassword, 'GOTENBERG_PASSWORD')
  const app = createService({ logger })
  app.decorateRequest('subject', null)
  app.decorateRequest('tenantId', null)
  app.get('/health', async (_request, reply) => {
    try {
      const response = await fetchImpl(rendererUrl + '/health', { redirect: 'error', signal: AbortSignal.timeout(2000) })
      await response.body?.cancel()
      if (response.ok) return { status: 'ok' }
    } catch { /* renderer is unavailable */ }
    return reply.code(503).send({ status: 'unavailable' })
  })
  app.post('/convert', { preValidation: authorize, schema: { body: uploadSchema } }, async (request, reply) => {
    const { filename, file } = request.body
    const bytes = readUpload(file)
    const extension = filename.toLowerCase().split('.').at(-1)
    const form = new FormData()
    let route
    if (extension === 'docx') {
      await validateWordFile(bytes)
      form.append('files', new Blob([bytes], { type: docxType }), 'document.docx')
      // Print Word content-control values into the page. Interactive PDF widgets
      // can hide or clip them when LibreOffice substitutes the control's font.
      form.append('exportFormFields', 'false')
      route = '/forms/libreoffice/convert'
    } else if (extension === 'html' || extension === 'htm') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        throw new InputError('Save the HTML file as UTF-8 and upload it again.')
      }
      form.append('files', new Blob([bytes], { type: 'text/html; charset=utf-8' }), 'index.html')
      form.append('printBackground', 'true')
      form.append('preferCssPageSize', 'true')
      route = '/forms/chromium/convert/html'
    } else {
      throw new InputError('Choose a DOCX or HTML file to convert.')
    }
    try {
      const response = await fetchImpl(rendererUrl + route, {
        method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(26_000),
        headers: { Authorization: 'Basic ' + Buffer.from('docuscripter:' + rendererPassword).toString('base64') },
      })
      if (!response.ok) {
        await response.body?.cancel()
        if ([400, 422].includes(response.status)) throw new InputError('The converter could not read this file.')
        return reply.code(502).send({ message: 'The PDF renderer could not complete the request.' })
      }
      const output = await readArtifact(response)
      if (!output.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF output')
      return sendAttachment(reply, output, pdfType, 'document.pdf')
    } catch (error) {
      if (error instanceof InputError) throw error
      return reply.code(error.name === 'TimeoutError' ? 504 : 502).send({ message: 'The PDF renderer is temporarily unavailable.' })
    }
  })
  return app
}
