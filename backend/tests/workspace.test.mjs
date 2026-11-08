import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { fixture, invoiceValues } from './helpers.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { createStore } from '../gateway/store.mjs'
import { maxOutputBytes } from '../shared/document-http.mjs'

async function generate(f, principal, payload = { templateId: 'invoice', values: invoiceValues() }) {
  return f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: principal.headers, payload })
}
async function jobs(f, principal) {
  const result = await f.gateway.inject({ url: '/api/jobs', headers: principal.headers })
  assert.equal(result.statusCode, 200)
  return result.json().items
}

test('all document and storage endpoints require authentication before validating input', async (t) => {
  const f = await fixture(t)
  const id = randomUUID()
  for (const [method, url] of [
    ['POST', '/api/docx/generate'], ['POST', '/api/pdf/convert'], ['POST', '/api/templates'],
    ['GET', '/api/jobs'], ['GET', '/api/jobs/' + id], ['GET', '/api/jobs/' + id + '/download'], ['DELETE', '/api/jobs/' + id],
    ['GET', '/api/templates'], ['GET', '/api/templates/' + id + '/download'], ['DELETE', '/api/templates/' + id],
  ]) {
    assert.equal((await f.gateway.inject({ method, url })).statusCode, 401, method + ' ' + url)
  }
  assert.equal(f.authCalls, 0)
})

test('real DOCX generation persists bytes and metadata across gateway restarts', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  assert.deepEqual(await jobs(f, owner), [])
  const result = await generate(f, owner)
  assert.equal(result.statusCode, 200, result.body)
  const id = result.headers['x-document-id']
  assert.ok(id)
  const xml = new PizZip(result.rawPayload).file('word/document.xml').asText()
  assert.ok(xml.includes('Document pipeline verification'))
  assert.ok(!xml.includes('{invoice_number}'))
  await f.restart()
  const [job] = await jobs(f, owner)
  assert.equal(job.id, id)
  assert.equal(job.status, 'ready')
  assert.equal(job.name, 'Invoice.docx')
  const restored = await f.gateway.inject({ url: '/api/jobs/' + id + '/download', headers: owner.headers })
  assert.equal(restored.statusCode, 200)
  assert.deepEqual(restored.rawPayload, result.rawPayload)
  assert.equal(restored.headers['cache-control'], 'no-store')
})

test('documents and templates remain private to their tenant even from another tenant admin', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  const other = f.principal('admin')
  const generated = await generate(f, owner)
  const id = generated.headers['x-document-id']
  const file = (await starterTemplate('invoice')).toString('base64')
  const saved = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers: owner.headers, payload: { name: 'Pipeline template', filename: 'source.docx', file } })
  assert.equal(saved.statusCode, 201, saved.body)
  const templateId = saved.json().id
  assert.deepEqual(await jobs(f, other), [])
  assert.deepEqual((await f.gateway.inject({ url: '/api/templates', headers: other.headers })).json().items, [])
  for (const [method, url] of [
    ['GET', '/api/jobs/' + id], ['GET', '/api/jobs/' + id + '/download'], ['DELETE', '/api/jobs/' + id],
    ['GET', '/api/templates/' + templateId + '/download'], ['DELETE', '/api/templates/' + templateId],
  ]) assert.equal((await f.gateway.inject({ method, url, headers: other.headers })).statusCode, 404)
  assert.equal((await generate(f, other, { savedTemplateId: templateId, values: invoiceValues() })).statusCode, 404)
})

test('saved templates are inspected, survive restart, generate documents, and can be deleted', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  const bytes = await starterTemplate('invoice')
  const result = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers: owner.headers, payload: { name: 'Saved invoice', filename: 'invoice.docx', file: bytes.toString('base64') } })
  assert.equal(result.statusCode, 201, result.body)
  const saved = result.json()
  assert.deepEqual(saved.fields, ['invoice_number', 'customer_name', 'description', 'amount_due'])
  await f.restart()
  assert.equal((await f.gateway.inject({ url: '/api/templates', headers: owner.headers })).json().items[0].id, saved.id)
  const downloaded = await f.gateway.inject({ url: '/api/templates/' + saved.id + '/download', headers: owner.headers })
  assert.deepEqual(downloaded.rawPayload, bytes)
  const generated = await generate(f, owner, { savedTemplateId: saved.id, values: invoiceValues() })
  assert.equal(generated.statusCode, 200, generated.body)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/templates/' + saved.id, headers: owner.headers })).statusCode, 204)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/jobs/' + generated.headers['x-document-id'], headers: owner.headers })).statusCode, 204)
  assert.deepEqual(await jobs(f, owner), [])
})

test('viewer cannot process or upload templates; editable user metadata cannot grant access', async (t) => {
  const f = await fixture(t)
  const viewer = f.principal('viewer')
  viewer.user.user_metadata = { workspace_role: 'workspace-admin' }
  assert.deepEqual(await jobs(f, viewer), [])
  for (const url of ['/api/docx/generate', '/api/pdf/convert', '/api/templates']) {
    assert.equal((await f.gateway.inject({ method: 'POST', url, headers: viewer.headers, payload: {} })).statusCode, 403)
  }
  f.setRole(viewer, 'operator')
  assert.equal((await generate(f, viewer)).statusCode, 200)
  f.setRole(viewer, 'viewer')
  assert.equal((await generate(f, viewer)).statusCode, 403)
  // A demoted user can still download their own previously generated document.
  const [job] = await jobs(f, viewer)
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + job.id + '/download', headers: viewer.headers })).statusCode, 200)
})

test('expired tokens, anonymous users and auth outages fail closed', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { authorization: 'Bearer invalid' } })).statusCode, 401)
  owner.user.is_anonymous = true
  assert.equal((await generate(f, owner)).statusCode, 403)
  const offline = await fixture(t, { authFailure: true })
  assert.equal((await generate(offline, offline.principal())).statusCode, 503)
})

test('invalid schemas and uploads do not create jobs or saved templates', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  for (const payload of [
    { templateId: 'invoice', values: { amount_due: 42 } },
    { templateId: 'invoice', savedTemplateId: randomUUID(), values: {} },
    { templateId: 'invoice', values: { constructor: 'blocked' } },
  ]) assert.equal((await generate(f, owner, payload)).statusCode, 400)
  assert.equal((await generate(f, owner, { filename: 'source.docx', file: '!!!!', values: {} })).statusCode, 422)
  const bad = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers: owner.headers, payload: { name: 'Invalid', filename: 'bad.docx', file: Buffer.from('not a ZIP').toString('base64') } })
  assert.equal(bad.statusCode, 422)
  assert.deepEqual((await f.gateway.inject({ url: '/api/templates', headers: owner.headers })).json().items, [])
  assert.deepEqual(await jobs(f, owner), [])
})

test('template failures and unavailable processing services are recorded without artifacts', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  assert.equal((await generate(f, owner, { templateId: 'invoice', values: {} })).statusCode, 422)
  const [failed] = await jobs(f, owner)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /Provide a value/)
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + failed.id + '/download', headers: owner.headers })).statusCode, 404)
  const offline = await fixture(t, { transportFailure: true })
  const operator = offline.principal()
  assert.equal((await generate(offline, operator)).statusCode, 502)
  assert.equal((await jobs(offline, operator))[0].status, 'failed')
})

test('PDF adapter authenticates with renderer, persists PDFs and reports renderer failures', async (t) => {
  for (const options of [{}, { rendererFailure: true }, { invalidPdf: true }]) {
    const f = await fixture(t, options)
    const owner = f.principal()
    const result = await f.gateway.inject({ method: 'POST', url: '/api/pdf/convert', headers: owner.headers,
      payload: { filename: 'input.html', file: Buffer.from('<h1>Conversion check</h1>').toString('base64') } })
    const expected = options.rendererFailure || options.invalidPdf ? 502 : 200
    assert.equal(result.statusCode, expected, result.body)
    assert.equal(f.rendererCalls, 1)
    assert.equal((await jobs(f, owner))[0].status, expected === 200 ? 'ready' : 'failed')
  }
})

test('SQLite isolates tenants, pages history, and reserves tenant quota', () => {
  const owner = randomUUID(), other = randomUUID()
  const store = createStore(':memory:', { quotaBytes: maxOutputBytes * 2 })
  try {
    const job = store.beginJob(owner, { name: 'pending.docx', kind: 'DOCX', source: 'invoice', createdBy: owner })
    assert.throws(() => store.deleteJob(owner, job), { statusCode: 409 })
    store.beginJob(owner, { name: 'pending.docx', kind: 'DOCX', source: 'invoice', createdBy: owner })
    assert.throws(() => store.beginJob(owner, { name: 'blocked.docx', kind: 'DOCX', source: 'invoice', createdBy: owner }), { statusCode: 409 })
    assert.equal(store.job(other, job), undefined)
    store.completeJob(owner, job, Buffer.from('PK'))
    assert.equal(store.deleteJob(other, job), false)
    for (let i = 0; i < 51; i++) {
      const id = store.beginJob(other, { name: 'pagination.docx', kind: 'DOCX', source: 'invoice', createdBy: owner })
      store.failJob(other, id, 'Failed')
    }
    assert.equal(store.listJobs(other).length, 50)
    assert.equal(store.listJobs(other, 50).length, 1)
  } finally { store.close() }
})

test('pending jobs become failed on restart without disturbing ready documents', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'workspace.sqlite'), owner = randomUUID()
  let store = createStore(path)
  const pending = store.beginJob(owner, { name: 'pending.docx', kind: 'DOCX', source: 'invoice', createdBy: owner })
  store.close()
  store = createStore(path)
  try { assert.equal(store.job(owner, pending).status, 'failed'); assert.match(store.job(owner, pending).error, /interrupted/) }
  finally { store.close() }
})
