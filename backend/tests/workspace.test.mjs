import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
    ['GET', '/api/templates/mine'], ['GET', '/api/templates/mine/' + id + '/download'],
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

test('download names preserve version numbers, append a single extension and keep Unicode boundaries intact', async t => {
  const f = await fixture(t), owner = f.principal()
  const file = (await starterTemplate('invoice')).toString('base64')
  const filename = response => decodeURIComponent(response.headers['content-disposition'].split("filename*=UTF-8''")[1])
  for (const title of ['Invoice v2.1', 'Invoice.DOCX']) {
    const created = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers: owner.headers,
      payload: { name: title, filename: 'invoice.docx', file } })
    assert.equal(created.statusCode, 201)
    const id = created.json().id
    const source = await f.gateway.inject({ url: '/api/templates/' + id + '/download', headers: owner.headers })
    const output = await generate(f, owner, { savedTemplateId: id, values: invoiceValues() })
    assert.equal(output.statusCode, 200)
    const expected = title === 'Invoice.DOCX' ? 'Invoice.docx' : 'Invoice v2.1.docx'
    assert.equal(filename(source), expected)
    assert.equal(filename(output), expected)
  }
  const longName = 'a'.repeat(199) + '📄.docx'
  const result = await generate(f, owner, { filename: longName, file, values: invoiceValues() })
  assert.equal(result.statusCode, 200)
  const saved = await f.gateway.inject({ url: '/api/jobs/' + result.headers['x-document-id'], headers: owner.headers })
  assert.equal(saved.json().name, filename(result))
  assert.equal(saved.json().source, longName)
  assert.equal(filename(result), 'a'.repeat(199) + '.docx')
})

test('Activity advertises another page only when more tenant records exist', async t => {
  const f = await fixture(t), owner = f.principal()
  const store = createStore(join(f.dir, 'workspace.sqlite'))
  t.after(() => store.close())
  function add(tenantId) {
    const id = store.beginJob(tenantId, { name: 'Invoice.docx', kind: 'DOCX', source: 'invoice', createdBy: owner.user.id })
    store.failJob(tenantId, id, 'Processing stopped.')
  }
  for (let i = 0; i < 50; i++) add(owner.tenantId)
  add(randomUUID())
  const page = async offset => (await f.gateway.inject({ url: '/api/jobs?offset=' + offset, headers: owner.headers })).json()
  const full = await page(0)
  assert.equal(full.items.length, 50)
  assert.equal(full.nextOffset, null)
  add(owner.tenantId)
  assert.equal((await page(0)).nextOffset, 50)
  const last = await page(50)
  assert.equal(last.items.length, 1)
  assert.equal(last.nextOffset, null)
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

test('the editor reopens only its user’s original templates from the selected organization', async (t) => {
  const f = await fixture(t)
  const owner = f.principal()
  const coworker = f.principal('admin', owner.tenantId)
  const other = f.principal()
  f.setRole(owner, 'operator', other.tenantId)
  const otherWorkspace = { ...owner.headers, 'x-tenant-id': other.tenantId }
  const bytes = await starterTemplate('invoice')
  const save = async (headers) => {
    const result = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers,
      payload: { name: 'Saved invoice', filename: 'invoice.docx', file: bytes.toString('base64') } })
    assert.equal(result.statusCode, 201, result.body)
    return result.json().id
  }
  const mine = await save(owner.headers)
  const theirs = await save(coworker.headers)
  const elsewhere = await save(otherWorkspace)
  await f.restart()
  const list = async (headers, url = '/api/templates/mine') => {
    const response = await f.gateway.inject({ url, headers })
    assert.equal(response.statusCode, 200, response.body)
    return response.json().items.map((item) => item.id)
  }
  assert.deepEqual(await list(owner.headers), [mine])
  assert.deepEqual(await list(otherWorkspace), [elsewhere])
  assert.deepEqual(await list(other.headers), [])
  assert.deepEqual((await list(owner.headers, '/api/templates')).sort(), [mine, theirs].sort())
  const download = (headers, id) => f.gateway.inject({ headers, url: '/api/templates/mine/' + id + '/download' })
  f.setRole(owner, 'viewer')
  const reopened = await download(owner.headers, mine)
  assert.equal(reopened.statusCode, 200, reopened.body)
  assert.deepEqual(reopened.rawPayload, bytes)
  assert.equal((await download(coworker.headers, mine)).statusCode, 404)
  assert.equal((await download(owner.headers, elsewhere)).statusCode, 404)
  f.setRole(owner, null)
  assert.equal((await download(owner.headers, mine)).statusCode, 403)
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
