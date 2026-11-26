import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { registerBatchRoutes } from '../gateway/batch-routes.mjs'
import { createService } from '../shared/http-service.mjs'
import { batchFilenames } from '../../shared/batch-filenames.mjs'
import { fixture, invoiceValues } from './helpers.mjs'

const base = '/api/batches'
const row = (name, customer = 'Recipient') => ({ name, values: { ...invoiceValues(), customer_name: customer } })
const input = (rows, format = 'DOCX') => ({ templateId: 'invoice', format, rows })
const call = (f, user, method, url, payload, headers = {}) => f.gateway.inject({
  method, url, payload, headers: { ...user.headers, ...headers },
})
async function create(f, owner, body, headers) {
  const result = await call(f, owner, 'POST', base, body, headers)
  assert.equal(result.statusCode, 201, result.body)
  return result.json()
}
async function credential(f, owner, granted, scope) {
  const provision = await call(f, owner, 'POST', '/api/tenant/clients', { name: 'Batch integration', scopes: granted })
  assert.equal(provision.statusCode, 201)
  const { id, clientSecret } = provision.json()
  async function token(scope) {
    const result = await f.gateway.inject({ method: 'POST', url: '/api/oauth/token',
      headers: { authorization: 'Basic ' + Buffer.from(id + ':' + clientSecret).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials', scope: scope.join(' ') }).toString() })
    assert.equal(result.statusCode, 200, result.body)
    return { headers: { authorization: 'Bearer ' + result.json().access_token } }
  }
  return { token, user: await token(scope), id }
}

test('batch filenames preserve references and avoid unsafe and case-insensitive colliding ZIP entries', () => {
  const names = batchFilenames(['001234', 'x', 'X', 'X (2)', '../Foo', 'CON', 'aux.txt', ' A / B ', '\u0001', '.', 'é', 'e\u0301'], 'PDF')
  assert.deepEqual(names, ['001234.pdf', 'x.pdf', 'X (3).pdf', 'X (2).pdf', '_Foo.pdf', '_CON.pdf', '_aux.txt.pdf',
    'A _ B.pdf', '_.pdf', 'Document.pdf', 'é.pdf', 'é (2).pdf'])
  assert.ok(Buffer.byteLength(batchFilenames(['💼'.repeat(120)], 'DOCX')[0]) <= 255)
})

test('a roster can be preflighted and resumed after restart without resubmitting successful rows', async (t) => {
  const f = await fixture(t), owner = f.principal('owner')
  const draft = input([row('001234', 'Recipient One'), row('001235', 'Recipient Two')])
  const key = { 'idempotency-key': randomUUID() }
  const batch = await create(f, owner, draft, key)
  const url = base + '/' + batch.id
  assert.equal(batch.pending, 2)
  assert.equal(batch.rows[0].name, '001234.docx')
  assert.equal(batch.rows[0].index, 1)
  assert.doesNotMatch(JSON.stringify(batch), /Recipient One/)
  assert.equal((await create(f, owner, draft, key)).id, batch.id)
  assert.equal((await call(f, owner, 'POST', base, input([row('different')]), key)).statusCode, 409)
  assert.equal((await call(f, owner, 'GET', url + '/download')).statusCode, 409)

  const first = await call(f, owner, 'POST', url + '/next')
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().ready, 1)
  let archive = await call(f, owner, 'GET', url + '/download')
  assert.equal(archive.statusCode, 200)
  assert.equal(archive.headers['x-batch-omitted-count'], '1')
  await f.restart()
  const after = await call(f, owner, 'POST', url + '/next')
  assert.equal(after.json().pending, 0)
  assert.equal(after.json().ready, 2)
  const repeated = await call(f, owner, 'POST', url + '/next')
  assert.deepEqual(repeated.json().rows, after.json().rows)
  archive = await call(f, owner, 'GET', url + '/download')
  const zip = new PizZip(archive.rawPayload)
  for (const [index, name] of ['001234.docx', '001235.docx'].entries()) {
    const xml = new PizZip(zip.file(name).asNodeBuffer()).file('word/document.xml').asText()
    assert.ok(xml.includes(draft.rows[index].values.customer_name))
  }
  const files = after.json().rows
  assert.equal((await call(f, owner, 'DELETE', '/api/jobs/' + files[0].jobId)).statusCode, 204)
  assert.equal((await call(f, owner, 'GET', url)).json().rows[0].available, false)
  archive = await call(f, owner, 'GET', url + '/download')
  assert.deepEqual(Object.keys(new PizZip(archive.rawPayload).files), ['001235.docx'])
  assert.equal(archive.headers['x-batch-file-count'], '1')
  assert.equal(archive.headers['x-batch-omitted-count'], '1')
  assert.equal((await call(f, owner, 'DELETE', url)).statusCode, 204)
  assert.equal((await call(f, owner, 'GET', url)).statusCode, 404)
  assert.equal((await call(f, owner, 'GET', '/api/jobs/' + files[1].jobId + '/download')).statusCode, 200)
})

test('batch creation validates all rows and isolates the roster to its tenant and creator', async (t) => {
  const f = await fixture(t), owner = f.principal('owner'), same = f.principal('admin', owner.tenantId), other = f.principal('owner')
  for (const bad of [
    input([row('valid'), { name: 'missing', values: {} }]),
    input([{ name: 'extra', values: { ...invoiceValues(), unused: 'restricted' } }]),
  ]) assert.equal((await call(f, owner, 'POST', base, bad)).statusCode, 422)
  for (const bad of [
    input(Array.from({ length: 101 }, () => row('row'))),
    { ...input([row('two')]), savedTemplateId: randomUUID() }, input([row(' ')]), input([row('too long', 'x'.repeat(4001))]),
  ]) assert.equal((await call(f, owner, 'POST', base, bad)).statusCode, 400)
  assert.deepEqual((await call(f, owner, 'GET', base)).json().items, [])
  const batch = await create(f, owner, input([row('private')]))
  const url = base + '/' + batch.id
  for (const actor of [same, other]) {
    assert.deepEqual((await call(f, actor, 'GET', base)).json().items, [])
    for (const [method, endpoint] of [['GET', url], ['POST', url + '/next'], ['GET', url + '/download'], ['DELETE', url]]) {
      assert.equal((await call(f, actor, method, endpoint)).statusCode, 404)
    }
  }
  f.setRole(owner, 'viewer')
  assert.equal((await call(f, owner, 'POST', url + '/next')).statusCode, 403)
})

test('first-file review and a repeated row request never generate the following recipient', async (t) => {
  const f = await fixture(t), person = f.principal()
  const batch = await create(f, person, input([row('001'), row('002')]))
  const next = base + '/' + batch.id + '/next?row='
  assert.equal((await call(f, person, 'POST', next + '2')).statusCode, 409)
  assert.equal((await call(f, person, 'POST', next + '3')).statusCode, 400)
  const first = (await call(f, person, 'POST', next + '1')).json()
  assert.deepEqual(first.rows.map(row => row.status), ['ready', 'pending'])
  assert.deepEqual((await call(f, person, 'POST', next + '1')).json(), first)
  const done = (await call(f, person, 'POST', next + '2')).json()
  assert.equal(done.ready, 2)
  assert.equal(done.rows[0].jobId, first.rows[0].jobId)
  assert.deepEqual((await call(f, person, 'POST', next + '1')).json(), done)
})

test('certificate preflight returns the row number and leaves rejected rosters out of history', async (t) => {
  const f = await fixture(t), owner = f.principal()
  const first = { name: '001', values: { recipient_name: 'Recipient', course_name: 'Training', completion_date: '2026-11-26',
    issuer_name: 'Instructor', certificate_id: '001' } }
  for (const [changes, message] of [
    [{ recipient_name: '  ', certificate_id: '002' }, /row 2 needs a value for \{recipient_name\}/],
    [{ certificate_id: ' 001 ' }, /row 2 repeats the certificate ID from data row 1/],
  ]) {
    const second = { name: '002', values: { ...first.values, ...changes } }
    const result = await call(f, owner, 'POST', base, { templateId: 'certificate', format: 'PDF', rows: [first, second] })
    assert.equal(result.statusCode, 422)
    assert.match(result.json().message, message)
  }
  assert.deepEqual((await call(f, owner, 'GET', base)).json().items, [])
})

test('download rejects oversized archives before fetching any artifact bytes', async t => {
  const app = createService({ logger: false })
  t.after(() => app.close())
  const rows = Array.from({ length: 3 }, () => ({ available: true, size: 11 * 1024 * 1024 }))
  let reads = 0
  registerBatchRoutes(app, {
    auth: { documentAccess: () => async () => {}, recheckProcessing: async () => {} },
    processing: async (_tenant, _reply, work) => work(),
    store: { batch: () => ({ format: 'DOCX', rows }), artifact() { reads++; throw Error('Unexpected artifact read') } },
  })
  const response = await app.inject({ url: base + '/' + randomUUID() + '/download' })
  assert.equal(response.statusCode, 409)
  assert.match(response.json().message, /32 MiB archive limit\. Download individual files/)
  assert.equal(reads, 0)
})

test('machine callers need generation, conversion and saved-template scopes as applicable', async (t) => {
  const f = await fixture(t), admin = f.principal('admin')
  const client = await credential(f, admin, ['documents:generate','documents:convert','templates:read'], ['documents:generate'])
  const convertOnly = await client.token(['documents:convert'])
  const full = await client.token(['documents:generate','documents:convert','templates:read'])
  const saved = await call(f, admin, 'POST', '/api/templates', { name: 'Office letter', filename: 'layout.docx',
    file: (await starterTemplate('invoice')).toString('base64') })
  const payload = { savedTemplateId: saved.json().id, rows: [row('contract')], format: 'PDF' }
  assert.equal((await call(f, convertOnly, 'POST', base, payload)).statusCode, 403)
  assert.equal((await call(f, client.user, 'POST', base, payload)).statusCode, 403)
  const withoutRead = await client.token(['documents:generate','documents:convert'])
  assert.equal((await call(f, withoutRead, 'POST', base, payload)).statusCode, 403)
  const key = { 'idempotency-key': randomUUID() }
  const batch = await create(f, full, payload, key)
  const url = base + '/' + batch.id
  assert.deepEqual((await call(f, client.user, 'GET', base)).json().items, [])
  assert.equal((await call(f, client.user, 'GET', url)).statusCode, 403)
  assert.equal((await call(f, withoutRead, 'POST', url + '/next')).statusCode, 403)
  const finished = await call(f, full, 'POST', url + '/next')
  assert.equal(finished.statusCode, 200, finished.body)
  assert.equal(finished.json().ready, 1)
  assert.equal(f.rendererCalls, 1)
  const artifact = await call(f, full, 'GET', url + '/download')
  assert.ok(new PizZip(artifact.rawPayload).file('contract.pdf').asText().startsWith('%PDF-'))
  assert.equal((await call(f, admin, 'GET', '/api/jobs')).json().items.length, 1)
  assert.equal((await call(f, admin, 'DELETE', '/api/templates/' + saved.json().id)).statusCode, 204)
  assert.equal((await create(f, full, payload, key)).id, batch.id)
  await call(f, admin, 'DELETE', '/api/tenant/clients/' + client.id)
  assert.equal((await call(f, full, 'GET', url + '/download')).statusCode, 401)
})

test('losing permission between generation and conversion prevents a PDF request or committed artifact', async (t) => {
  let owner
  const f = await fixture(t, { onServiceResult: () => f.setRole(owner, 'viewer') })
  owner = f.principal('owner')
  const batch = await create(f, owner, input([row('notice')], 'PDF'))
  const result = await call(f, owner, 'POST', base + '/' + batch.id + '/next')
  assert.equal(result.statusCode, 403)
  assert.equal(f.rendererCalls, 0)
  f.setRole(owner, 'operator')
  const detail = (await call(f, owner, 'GET', base + '/' + batch.id)).json()
  assert.equal(detail.failed, 1)
  assert.equal(detail.rows[0].available, false)
})

test('concurrent advances claim one row while deletion waits, service failures leave later rows pending', async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, { rendererFailure: true, onServiceResult: async () => { entered.resolve(); await release.promise } })
  const owner = f.principal(), batch = await create(f, owner, input([row('first'), row('second')], 'PDF'))
  const url = base + '/' + batch.id
  const running = call(f, owner, 'POST', url + '/next')
  await entered.promise
  try {
    assert.equal((await call(f, owner, 'POST', url + '/next')).statusCode, 409)
    assert.equal((await call(f, owner, 'DELETE', url)).statusCode, 409)
  } finally { release.resolve() }
  assert.equal((await running).statusCode, 502)
  const detail = (await call(f, owner, 'GET', url)).json()
  assert.deepEqual(detail.rows.map(r => r.status), ['failed', 'pending'])
})
