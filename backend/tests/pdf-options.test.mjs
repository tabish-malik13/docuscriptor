import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { buildPdfApp } from '../pdf/app.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'

test('DOCX conversion preserves the source and prints content controls instead of PDF widgets', async (t) => {
  const zip = new PizZip(await starterTemplate('letter'))
  zip.file('word/document.xml', zip.file('word/document.xml').asText().replace('</w:body>',
    '<w:p><w:sdt><w:sdtPr><w:alias w:val="Contract clause"/></w:sdtPr><w:sdtContent><w:r><w:t>Payment terms must remain visible.</w:t></w:r></w:sdtContent></w:sdt></w:p></w:body>'))
  const source = zip.generate({ type: 'nodebuffer' })
  const secret = randomBytes(32).toString('hex'), password = randomBytes(32).toString('hex')
  let calls = 0
  const app = buildPdfApp({ secret, rendererPassword: password, logger: false,
    fetchImpl: async (url, request) => {
      calls++
      assert.equal(url, 'http://127.0.0.1:3000/forms/libreoffice/convert')
      assert.equal(request.headers.Authorization, 'Basic ' + Buffer.from('docuscripter:' + password).toString('base64'))
      assert.equal(request.body.get('exportFormFields'), 'false')
      assert.deepEqual(Buffer.from(await request.body.get('files').arrayBuffer()), source)
      return new Response('%PDF-1.7\n%%EOF')
    },
  })
  t.after(() => app.close())
  const payload = { filename: 'contract.docx', file: source.toString('base64') }
  const response = await app.inject({ method: 'POST', url: '/convert', payload,
    headers: { authorization: signServiceRequest(secret, 'pdf', randomUUID(), '/convert', payload, randomUUID()) } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(calls, 1)
})
