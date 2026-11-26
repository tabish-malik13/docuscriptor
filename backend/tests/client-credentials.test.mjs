import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fixture, invoiceValues } from './helpers.mjs'
import { clientScopes, credentialDigest } from '../gateway/client-credentials.mjs'

const collection = '/api/tenant/clients'
const generation = { templateId: 'invoice', values: invoiceValues() }
const provision = (f, headers, scopes = [...clientScopes]) => f.gateway.inject({
  method: 'POST', url: collection, headers, payload: { name: 'Document integration', scopes },
})
const exchange = (f, client, form = 'grant_type=client_credentials', extra = {}) => f.gateway.inject({
  method: 'POST', url: '/api/oauth/token',
  headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(client.id + ':' + client.clientSecret).toString('base64'), ...extra },
  payload: form,
})
const bearer = (token) => ({ authorization: 'Bearer ' + token })

test('only workspace administrators can manage client secrets and access the credential inventory', async (t) => {
  const f = await fixture(t), owner = f.principal('owner'), other = f.principal('owner')
  const member = f.principal('operator', owner.tenantId)
  assert.equal((await provision(f, member.headers)).statusCode, 403)
  assert.equal((await provision(f, owner.headers, ['admin'])).statusCode, 400)
  assert.equal((await provision(f, owner.headers, ['documents:read', 'documents:read'])).statusCode, 400)
  const created = await provision(f, owner.headers)
  assert.equal(created.statusCode, 201, created.body)
  const client = created.json()
  assert.ok(client.clientSecret)
  assert.equal(client.createdBy, owner.user.id)
  assert.equal(created.headers['cache-control'], 'no-store')
  const route = collection + '/' + client.id
  assert.deepEqual((await f.gateway.inject({ url: collection, headers: other.headers })).json().items, [])
  assert.equal((await f.gateway.inject({ method: 'POST', url: route + '/rotate', headers: other.headers })).statusCode, 404)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: route, headers: other.headers })).statusCode, 404)
  assert.equal((await f.gateway.inject({ url: collection, headers: member.headers })).statusCode, 403)
  const list = await f.gateway.inject({ url: collection, headers: owner.headers })
  assert.equal(list.json().items[0].id, client.id)
  for (const field of ['clientSecret', 'secretHash', 'secret_hash']) assert.equal(field in list.json().items[0], false)
  const token = (await exchange(f, client)).json().access_token
  const before = f.authCalls
  for (const authorization of [bearer(token), bearer(client.clientSecret), bearer('\t' + client.clientSecret)]) {
    for (const url of ['/api/organizations', collection, '/api/tenant/members', '/api/templates/mine', '/api/templates/mine/' + randomUUID() + '/download']) {
      assert.equal((await f.gateway.inject({ url, headers: { ...authorization, 'x-tenant-id': owner.tenantId } })).statusCode, 401)
    }
  }
  assert.equal(f.authCalls, before)
})

test('an administrator demoted while uploading a credential mutation cannot finish it', async (t) => {
  const f = await fixture(t), admin = f.principal('admin')
  const client = (await provision(f, admin.headers)).json()
  const route = collection + '/' + client.id
  for (const [method, url] of [['POST', route + '/rotate'], ['DELETE', route]]) {
    f.setRole(admin, 'admin')
    let parsed = false
    const payload = new Readable({ read() {
      parsed = true
      f.setRole(admin, 'viewer')
      this.push('{}')
      this.push(null)
    } })
    const result = await f.gateway.inject({ method, url, payload, headers: { ...admin.headers, 'content-type': 'application/json', 'content-length': '2' } })
    assert.ok(parsed)
    assert.equal(result.statusCode, 403, result.body)
    assert.equal((await exchange(f, client)).statusCode, 200)
  }
})

test('credential audit retains every rotation, scopes by tenant and merges the latest 50 access changes', async (t) => {
  const auditEvents = new Map()
  const f = await fixture(t, { auditEvents }), owner = f.principal('owner'), admin = f.principal('admin', owner.tenantId)
  const other = f.principal('owner'), viewer = f.principal('viewer', owner.tenantId)
  const audit = (headers) => f.gateway.inject({ url: '/api/tenant/audit', headers })
  const client = (await provision(f, owner.headers)).json()
  const route = collection + '/' + client.id
  for (const actor of [admin, owner]) {
    const result = await f.gateway.inject({ method: 'POST', url: route + '/rotate', headers: actor.headers })
    assert.equal(result.statusCode, 200, result.body)
  }
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: route, headers: admin.headers })).statusCode, 204)
  await f.restart()
  assert.equal((await audit(viewer.headers)).statusCode, 403)
  assert.deepEqual((await audit(other.headers)).json().items, [])
  const local = (await audit(owner.headers)).json().items
  assert.deepEqual(local.map((event) => event.action), ['client.revoked', 'client.rotated', 'client.rotated', 'client.created'])
  assert.deepEqual(local.map((event) => event.actor_id), [admin.user.id, owner.user.id, admin.user.id, owner.user.id])
  assert.equal(new Set(local.map((event) => event.id)).size, 4)
  for (const event of local) {
    assert.match(event.id, /^client:\d+$/)
    assert.equal(event.target_id, client.id)
    assert.deepEqual(Object.keys(event).sort(), ['action','actor_id','created_at','details','id','target_id'])
    assert.deepEqual(event.details, {})
  }
  const tenantEvents = Array.from({ length: 50 }, (_, i) => ({
    id: 50 - i, action: 'tenant.renamed', target_id: null, actor_id: owner.user.id, details: {},
    created_at: i === 0 ? local[0].created_at : new Date(Date.parse(local[3].created_at) - i).toISOString(),
  }))
  auditEvents.set(owner.tenantId, tenantEvents)
  const merged = (await audit(admin.headers)).json().items
  assert.equal(merged.length, 50)
  assert.deepEqual(merged, [tenantEvents[0], ...local, ...tenantEvents.slice(1, 46)])
  assert.deepEqual((await audit(admin.headers)).json().items, merged)
})

test('an unavailable credential audit rolls back provisioning, rotation, and revocation', async (t) => {
  const f = await fixture(t), owner = f.principal('owner')
  const client = (await provision(f, owner.headers)).json()
  const token = (await exchange(f, client)).json().access_token
  const db = new DatabaseSync(join(f.dir, 'workspace.sqlite'))
  try {
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON api_client_audit BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    const route = collection + '/' + client.id
    assert.equal((await provision(f, owner.headers)).statusCode, 500)
    assert.equal((await f.gateway.inject({ method: 'POST', url: route + '/rotate', headers: owner.headers })).statusCode, 500)
    assert.equal((await f.gateway.inject({ method: 'DELETE', url: route, headers: owner.headers })).statusCode, 500)
    assert.equal((await exchange(f, client)).statusCode, 200)
    assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: bearer(token) })).statusCode, 200)
    assert.equal(db.prepare('SELECT count(*) AS n FROM api_clients').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM api_client_audit').get().n, 1)
  } finally { db.close() }
})

test('active-token cap reports the earliest expiry and client inventory pages include older clients', async (t) => {
  const f = await fixture(t), owner = f.principal('owner')
  const client = (await provision(f, owner.headers)).json()
  const expected = new Set([client.id])
  const db = new DatabaseSync(join(f.dir, 'workspace.sqlite'))
  try {
    const insertToken = db.prepare('INSERT INTO api_access_tokens(token_hash,client_id,scopes,expires_at) VALUES(?,?,?,?)')
    const now = Date.now()
    for (let i = 0; i < 256; i++) insertToken.run(credentialDigest(String(i)), client.id, '[]', now + (i === 0 ? 30_000 : 90_000))
    const insertClient = db.prepare(`INSERT INTO api_clients(id,tenant_id,slug,name,scopes,created_at,created_by,revoked_at,revoked_by)
      SELECT ?,tenant_id,slug,name,scopes,created_at,created_by,created_at,created_by FROM api_clients WHERE id=?`)
    for (let i = 0; i < 53; i++) {
      const id = randomUUID()
      expected.add(id)
      insertClient.run(id, client.id)
    }
    const current = await exchange(f, client)
    assert.equal(current.statusCode, 429)
    assert.ok(Number(current.headers['retry-after']) >= 1 && Number(current.headers['retry-after']) <= 30)
  } finally { db.close() }
  const first = (await f.gateway.inject({ url: collection, headers: owner.headers })).json()
  const second = (await f.gateway.inject({ url: collection + '?offset=' + first.nextOffset, headers: owner.headers })).json()
  assert.equal(first.items.length, 50)
  assert.equal(second.items.length, 4)
  assert.equal(second.nextOffset, null)
  const fullLastPage = (await f.gateway.inject({ url: collection + '?offset=4', headers: owner.headers })).json()
  assert.equal(fullLastPage.items.length, 50)
  assert.equal(fullLastPage.nextOffset, null)
  assert.deepEqual(new Set([...first.items, ...second.items].map((item) => item.id)), expected)
})

test('client credentials grant enforces its configured tenant and scope, including narrower requested tokens', async (t) => {
  const f = await fixture(t), owner = f.principal('owner')
  const client = (await provision(f, owner.headers, ['documents:read', 'documents:generate'])).json()
  for (const form of ['grant_type=password', 'grant_type=client_credentials&grant_type=client_credentials', 'grant_type=client_credentials&scope=documents:delete']) {
    assert.equal((await exchange(f, client, form)).statusCode, 400)
  }
  for (const wrong of [{ ...client, id: randomUUID() }, { ...client, clientSecret: client.clientSecret.slice(0, -1) + '.' }]) {
    const result = await exchange(f, wrong)
    assert.equal(result.statusCode, 401)
    assert.equal(result.json().error, 'invalid_client')
  }
  const wrongTenant = { 'x-tenant-id': randomUUID() }
  assert.equal((await exchange(f, client, 'grant_type=client_credentials', wrongTenant)).statusCode, 401)
  const granted = await exchange(f, client, 'grant_type=client_credentials&scope=documents%3Aread')
  assert.equal(granted.statusCode, 200, granted.body)
  const { access_token, scope, expires_in } = granted.json()
  assert.ok(access_token)
  assert.equal(scope, 'documents:read')
  assert.equal(expires_in, 900)
  assert.equal(granted.headers['cache-control'], 'no-store')
  const headers = bearer(access_token)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers, payload: generation })).statusCode, 403)
  const full = bearer((await exchange(f, client)).json().access_token)
  const saved = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: full,
    payload: { savedTemplateId: randomUUID(), values: {} } })
  assert.equal(saved.statusCode, 403)
  assert.match(saved.headers['www-authenticate'], /templates:read/)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers })).statusCode, 200)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, ...wrongTenant } })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, host: 'wrong-workspace.docuscriptor.localhost' } })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/templates', headers })).statusCode, 403)
  const db = new DatabaseSync(join(f.dir, 'workspace.sqlite'))
  try {
    assert.deepEqual(Buffer.from(db.prepare('SELECT secret_hash FROM api_clients WHERE id=?').get(client.id).secret_hash), credentialDigest(client.clientSecret))
    assert.deepEqual(Buffer.from(db.prepare('SELECT token_hash FROM api_access_tokens WHERE client_id=?').get(client.id).token_hash), credentialDigest(access_token))
    db.prepare('UPDATE api_access_tokens SET expires_at=0 WHERE client_id=?').run(client.id)
  } finally { db.close() }
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers })).statusCode, 401)
})

test('rotation preserves document ownership, and revocation persists across gateway restarts', async (t) => {
  const f = await fixture(t), owner = f.principal('owner'), admin = f.principal('admin', owner.tenantId)
  const client = (await provision(f, owner.headers)).json()
  const token = (await exchange(f, client)).json().access_token
  const result = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: bearer(token), payload: generation })
  assert.equal(result.statusCode, 200, result.body)
  const document = '/api/jobs/' + result.headers['x-document-id']
  assert.equal((await f.gateway.inject({ url: document, headers: owner.headers })).json().createdBy, 'client:' + client.id)
  const otherClient = (await provision(f, owner.headers)).json()
  const otherToken = (await exchange(f, otherClient)).json().access_token
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: document, headers: bearer(otherToken) })).statusCode, 403)
  const route = collection + '/' + client.id
  const rotated = await f.gateway.inject({ method: 'POST', url: route + '/rotate', headers: admin.headers })
  assert.equal(rotated.statusCode, 200, rotated.body)
  assert.equal(rotated.json().id, client.id)
  assert.equal(rotated.json().rotatedBy, admin.user.id)
  assert.notEqual(rotated.json().clientSecret, client.clientSecret)
  assert.equal((await exchange(f, client)).statusCode, 401)
  assert.equal((await f.gateway.inject({ url: document, headers: bearer(token) })).statusCode, 401)
  const replacement = (await exchange(f, rotated.json())).json().access_token
  await f.restart()
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: document, headers: bearer(replacement) })).statusCode, 204)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: route, headers: admin.headers })).statusCode, 204)
  await f.restart()
  assert.equal((await exchange(f, rotated.json())).statusCode, 401)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: bearer(replacement) })).statusCode, 401)
  assert.equal((await f.gateway.inject({ method: 'POST', url: route + '/rotate', headers: owner.headers })).statusCode, 404)
  const record = (await f.gateway.inject({ url: collection, headers: owner.headers })).json().items.find((item) => item.id === client.id)
  assert.equal(record.revokedBy, admin.user.id)
  assert.ok(record.revokedAt)
})

test('processing-only tokens download their own output for the permitted format', async (t) => {
  const f = await fixture(t), owner = f.principal('owner')
  const client = (await provision(f, owner.headers, ['documents:generate', 'documents:convert'])).json()
  const generate = bearer((await exchange(f, client, 'grant_type=client_credentials&scope=documents%3Agenerate')).json().access_token)
  const convert = bearer((await exchange(f, client, 'grant_type=client_credentials&scope=documents%3Aconvert')).json().access_token)
  const docx = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: generate, payload: generation })
  const pdf = await f.gateway.inject({ method: 'POST', url: '/api/pdf/convert', headers: convert,
    payload: { filename: 'document.docx', file: docx.rawPayload.toString('base64') } })
  const human = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: owner.headers, payload: generation })
  for (const result of [docx, pdf, human]) assert.equal(result.statusCode, 200)
  for (const [result, granted, denied] of [[docx, generate, convert], [pdf, convert, generate]]) {
    const url = '/api/jobs/' + result.headers['x-document-id'] + '/download'
    assert.deepEqual((await f.gateway.inject({ url, headers: granted })).rawPayload, result.rawPayload)
    assert.equal((await f.gateway.inject({ url, headers: denied })).statusCode, 404)
    assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: granted })).statusCode, 403)
  }
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + human.headers['x-document-id'] + '/download', headers: generate })).statusCode, 404)
})

test('revoking an API client during processing withholds the artifact', async (t) => {
  let release, reached
  const paused = new Promise((resolve) => { reached = resolve })
  const resume = new Promise((resolve) => { release = resolve })
  const f = await fixture(t, { onServiceResult: async () => { reached(); await resume } }), owner = f.principal('owner')
  const client = (await provision(f, owner.headers)).json()
  const headers = bearer((await exchange(f, client)).json().access_token)
  const pending = f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers, payload: generation })
  await paused
  try {
    assert.equal((await f.gateway.inject({ method: 'DELETE', url: collection + '/' + client.id, headers: owner.headers })).statusCode, 204)
  } finally { release() }
  assert.equal((await pending).statusCode, 401)
  const [job] = (await f.gateway.inject({ url: '/api/jobs', headers: owner.headers })).json().items
  assert.equal(job.status, 'failed')
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + job.id + '/download', headers: owner.headers })).statusCode, 404)
})
