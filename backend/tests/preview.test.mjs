import test from 'node:test'
import assert from 'node:assert/strict'
import PizZip from 'pizzip'
import { fixture, invoiceValues } from './helpers.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { docxType } from '../shared/document-http.mjs'

const post = (app, path, headers, payload) => app.inject({ method: 'POST', url: path, headers, payload })
const documentXml = response => new PizZip(response.rawPayload).file('word/document.xml').asText()

test('live previews fill typed values, preserve unresolved tokens, and create no jobs', async t => {
  const f = await fixture(t)
  const { headers } = f.principal()
  const file = (await starterTemplate('invoice')).toString('base64')
  const saved = await post(f.gateway, '/api/templates', headers, { name: 'Invoice', filename: 'invoice.docx', file })
  assert.equal(saved.statusCode, 201, saved.body)
  for (const source of [{ templateId: 'invoice' }, { savedTemplateId: saved.json().id }, { filename: 'invoice.docx', file }]) {
    const result = await post(f.gateway, '/api/docx/preview', headers, { ...source, values: { customer_name: 'A & B <team>', invoice_number: '' } })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.headers['content-type'], docxType)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.headers['x-document-id'], undefined)
    const xml = documentXml(result)
    assert.match(xml, /A &amp; B &lt;team&gt;/)
    assert.doesNotMatch(xml, /\{customer_name\}/)
    assert.doesNotMatch(xml, /\{invoice_number\}/)
    assert.match(xml, /\{description\}/)
  }
  const jobs = await f.gateway.inject({ url: '/api/jobs', headers })
  assert.deepEqual(jobs.json().items, [])
  const strict = await post(f.gateway, '/api/docx/generate', headers, { templateId: 'invoice', values: {} })
  assert.equal(strict.statusCode, 422)
})

test('preview and generation use the chosen template version even after an edit', async t => {
  const f = await fixture(t)
  const { headers } = f.principal()
  const upload = async id => ({ filename: id + '.docx', file: (await starterTemplate(id)).toString('base64') })
  const saved = await post(f.gateway, '/api/templates', headers, { name: 'Template', ...await upload('invoice') })
  const savedTemplateId = saved.json().id
  const updated = await post(f.gateway, '/api/templates/' + savedTemplateId + '/versions', headers, { baseVersion: 1, ...await upload('letter') })
  assert.equal(updated.statusCode, 201, updated.body)
  const inputs = { savedTemplateId, savedTemplateVersion: 1, values: { ...invoiceValues(), customer_name: 'Acme' } }
  const preview = await post(f.gateway, '/api/docx/preview', headers, inputs)
  const generated = await post(f.gateway, '/api/docx/generate', headers, inputs)
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal(generated.statusCode, 200, generated.body)
  assert.match(documentXml(preview), /Acme/)
  assert.equal(documentXml(preview), documentXml(generated))
  const missing = await post(f.gateway, '/api/docx/preview', headers, { ...inputs, savedTemplateVersion: 3 })
  assert.equal(missing.statusCode, 404)
  const invalid = await post(f.gateway, '/api/docx/preview', headers, { templateId: 'invoice', savedTemplateVersion: 1, values: {} })
  assert.equal(invalid.statusCode, 400)
})

test('preview enforces identity, workspace, and processing rights before returning the document', async t => {
  let afterRender = () => {}
  const f = await fixture(t, { onServiceResult: () => afterRender() })
  const member = f.principal()
  const inputs = { templateId: 'certificate', values: {} }
  const preview = headers => post(f.gateway, '/api/docx/preview', headers, inputs)
  assert.equal((await preview({})).statusCode, 401)
  assert.equal((await preview(f.principal('viewer').headers)).statusCode, 403)
  assert.equal((await preview({ ...member.headers, 'x-tenant-id': f.principal().tenantId })).statusCode, 403)
  assert.equal((await post(f.docx, '/preview', {}, inputs)).statusCode, 401)
  afterRender = () => f.setRole(member, null)
  assert.equal((await preview(member.headers)).statusCode, 403)
})
