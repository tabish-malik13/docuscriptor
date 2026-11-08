import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, invoiceValues } from './helpers.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { createStore } from '../gateway/store.mjs'
import { createTenantAuthority } from '../gateway/tenant-authority.mjs'

const generation = { templateId: 'invoice', values: invoiceValues() }

test('tenant selection and membership are mandatory; account discovery needs only authentication', async (t) => {
  const f = await fixture(t), person = f.principal()
  const headers = { authorization: person.headers.authorization }
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers })).statusCode, 400)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, 'x-tenant-id': 'invalid' } })).statusCode, 400)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, 'x-tenant-id': randomUUID() } })).statusCode, 403)
  const result = await f.gateway.inject({ url: '/api/tenants', headers })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json().items.map((tenant) => tenant.id), [person.tenantId])
  assert.equal((await f.gateway.inject({ url: '/api/invitations', headers })).statusCode, 200)
  person.user.email_confirmed_at = null
  assert.equal((await f.gateway.inject({ url: '/api/tenants', headers })).statusCode, 403)
})

test('members share tenant artifacts and templates; viewers cannot delete and operators only delete their own', async (t) => {
  const f = await fixture(t), creator = f.principal('operator')
  const viewer = f.principal('viewer', creator.tenantId), operator = f.principal('operator', creator.tenantId), admin = f.principal('admin', creator.tenantId)
  const result = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: creator.headers, payload: generation })
  assert.equal(result.statusCode, 200, result.body)
  const jobId = result.headers['x-document-id']
  for (const member of [viewer, operator, admin]) {
    const history = (await f.gateway.inject({ url: '/api/jobs', headers: member.headers })).json().items
    assert.equal(history.length, 1)
    assert.equal(history[0].createdBy, creator.user.id)
    const saved = await f.gateway.inject({ url: '/api/jobs/' + jobId + '/download', headers: member.headers })
    assert.deepEqual(saved.rawPayload, result.rawPayload)
  }
  for (const member of [viewer, operator]) assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/jobs/' + jobId, headers: member.headers })).statusCode, 403)
  const source = await starterTemplate('invoice')
  const uploaded = await f.gateway.inject({ method: 'POST', url: '/api/templates', headers: creator.headers,
    payload: { name: 'Shared template', filename: 'template.docx', file: source.toString('base64') } })
  assert.equal(uploaded.statusCode, 201)
  const templateId = uploaded.json().id
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: operator.headers, payload: { savedTemplateId: templateId, values: invoiceValues() } })).statusCode, 200)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/templates/' + templateId, headers: operator.headers })).statusCode, 403)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/templates/' + templateId, headers: admin.headers })).statusCode, 204)
  assert.equal((await f.gateway.inject({ method: 'DELETE', url: '/api/jobs/' + jobId, headers: admin.headers })).statusCode, 204)
})

test('a multi-tenant user has independent roles and cannot use another tenant header to reach records', async (t) => {
  const f = await fixture(t), person = f.principal('admin'), second = f.principal('owner')
  f.setRole(person, 'viewer', second.tenantId)
  const result = await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: person.headers, payload: generation })
  const headers = { ...person.headers, 'x-tenant-id': second.tenantId }
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + result.headers['x-document-id'], headers })).statusCode, 404)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers, payload: generation })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/tenant/members', headers })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/tenant/members', headers: person.headers })).statusCode, 200)
})

test('removed members immediately lose downloads and pending results are discarded', async (t) => {
  let finish, entered
  const waiting = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { finish = resolve })
  const f = await fixture(t, { onServiceResult: async () => { entered(); await gate } })
  const person = f.principal('operator'), admin = f.principal('admin', person.tenantId)
  const pending = f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: person.headers, payload: generation })
  await waiting
  f.setRole(person, null)
  finish()
  const result = await pending
  assert.equal(result.statusCode, 403)
  const [job] = (await f.gateway.inject({ url: '/api/jobs', headers: admin.headers })).json().items
  assert.equal(job.status, 'failed')
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + job.id + '/download', headers: person.headers })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/jobs/' + job.id + '/download', headers: admin.headers })).statusCode, 404)
})

test('membership outages fail closed; global and user metadata cannot grant a tenant role', async (t) => {
  const f = await fixture(t, { membershipFailure: true }), person = f.principal()
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: person.headers, payload: generation })).statusCode, 503)
  const active = await fixture(t), viewer = active.principal('viewer')
  viewer.user.app_metadata = { workspace_role: 'workspace-admin', tenant_role: 'owner', tenant_id: viewer.tenantId }
  viewer.user.user_metadata = { role: 'owner', tenant_id: viewer.tenantId }
  for (const [method, url, payload] of [
    ['GET', '/api/tenant/members'], ['GET', '/api/tenant/audit'],
    ['PATCH', '/api/tenant', { name: 'Denied' }],
    ['POST', '/api/tenant/invitations', { email: viewer.user.email, role: 'admin' }],
    ['PATCH', '/api/tenant/members/' + viewer.user.id, { role: 'owner' }],
  ]) assert.equal((await active.gateway.inject({ method, url, payload, headers: viewer.headers })).statusCode, 403)
})

test('an authenticated user can create a named tenant without granting themselves access to others', async (t) => {
  const f = await fixture(t), person = f.principal()
  const response = await f.gateway.inject({ method: 'POST', url: '/api/tenants', headers: person.headers, payload: { name: 'User requested tenant' } })
  assert.equal(response.statusCode, 201)
  assert.equal(response.json().role, 'owner')
  assert.notEqual(response.json().id, person.tenantId)
  const forbidden = await f.gateway.inject({ method: 'POST', url: '/api/tenants', headers: person.headers, payload: { name: 'Denied', owner: randomUUID() } })
  assert.equal(forbidden.statusCode, 400)
})

test('Supabase tenant adapter uses the user token, tenant and subject filters, and reports a missing schema', async () => {
  const tenantId = randomUUID(), subject = randomUUID()
  const token = randomUUID(), calls = []
  let missing = false
  const authority = createTenantAuthority({ supabaseUrl: 'https://identity.invalid', publishableKey: 'sb_publishable_test', fetchImpl: async (url, request) => {
    calls.push({ url, request })
    return missing ? Response.json({ code: 'PGRST205' }, { status: 404 }) : Response.json([{ role: 'operator' }])
  } })
  assert.equal(await authority.membership(token, tenantId, subject), 'operator')
  assert.equal(calls[0].request.headers.Authorization, 'Bearer ' + token)
  assert.equal(calls[0].url.searchParams.get('tenant_id'), 'eq.' + tenantId)
  assert.equal(calls[0].url.searchParams.get('user_id'), 'eq.' + subject)
  missing = true
  await assert.rejects(authority.membership(token, tenantId, subject), { statusCode: 503, publicMessage: 'The Supabase tenant schema is not installed. Apply supabase/tenant-access.sql first.' })
})

test('v1 personal records stay quarantined until their creator explicitly imports them into a tenant', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'workspace.sqlite'), subject = randomUUID(), other = randomUUID(), tenantId = randomUUID()
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,status TEXT NOT NULL,error TEXT,artifact BLOB) STRICT;
    CREATE TABLE templates(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,created TEXT NOT NULL,fields TEXT NOT NULL,file BLOB NOT NULL) STRICT;
    PRAGMA user_version=1;`)
  const id = randomUUID(), secondId = randomUUID()
  for (const [job, owner] of [[id, subject], [secondId, other]]) db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(job,owner,'private.docx','DOCX','upload',new Date().toISOString(),'ready',null,Buffer.from('PK'))
  db.close()
  const store = createStore(path)
  try {
    assert.deepEqual(store.listJobs(tenantId), [])
    assert.equal(store.legacySummary(subject).jobs, 1)
    assert.deepEqual(store.importLegacy(tenantId, subject), { jobs: 1, templates: 0 })
    assert.equal(store.job(tenantId, id).createdBy, subject)
    assert.equal(store.job(tenantId, secondId), undefined)
    assert.equal(store.legacySummary(other).jobs, 1)
    assert.deepEqual(store.importLegacy(tenantId, subject), { jobs: 0, templates: 0 })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally { store.close() }
})
