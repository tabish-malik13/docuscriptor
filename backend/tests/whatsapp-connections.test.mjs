import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { openWhatsAppConnections } from '../whatsapp/connections.mjs'
import { fixture } from './helpers.mjs'

const path = '/api/tenant/whatsapp'
const secret = () => randomBytes(32).toString('hex')
const get = (f, p) => f.gateway.inject({ url: path, headers: p.headers })
const put = (f, p, payload) => f.gateway.inject({ method: 'PUT', url: path, headers: p.headers, payload })
const disconnect = (f, p, revision) => f.gateway.inject({ method: 'DELETE', url: path + '?revision=' + revision, headers: p.headers })
async function client(f, p) {
  const r = await f.gateway.inject({ method: 'POST', url: '/api/tenant/clients', headers: p.headers,
    payload: { name: 'Documents', scopes: ['documents:convert'] } })
  assert.equal(r.statusCode, 201)
  return r.json()
}
const setup = api => ({ revision: null, version: 'v27.0', phoneNumberId: '12345678', senders: ['19995550101','US.tenantSender'],
  accessToken: secret(), appSecret: secret(), clientId: api.id, clientSecret: api.clientSecret })

test('an organization admin can set up, edit without reentering secrets, rotate and disconnect across a restart', async t => {
  const f = await fixture(t), admin = f.principal('admin'), api = await client(f, admin)
  const input = setup(api)
  assert.deepEqual((await get(f, admin)).json(), { connection: null, clients: [{ id: api.id, name: 'Documents', scopes: ['documents:convert'] }], deploymentManagedNumbers: 0 })
  const created = await put(f, admin, input)
  assert.equal(created.statusCode, 200, created.body)
  assert.equal(created.headers['cache-control'], 'no-store')
  const { connection, verifyToken } = created.json()
  assert.match(verifyToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(new URL(connection.callbackUrl).pathname, '/api/integrations/whatsapp/webhook/' + connection.id)
  assert.equal(connection.verifiedAt, null)
  assert.equal(connection.deploymentConflict, false)
  for (const value of [input.appSecret,input.accessToken,input.clientSecret]) assert.ok(!created.body.includes(value))
  assert.equal((await put(f, admin, input)).statusCode, 409)
  await f.restart()
  const fetched = await get(f, admin)
  assert.deepEqual(fetched.json().connection, connection)
  for (const value of [input.appSecret,input.accessToken,input.clientSecret,verifyToken]) assert.ok(!fetched.body.includes(value))
  const edit = { version: 'v26.0', senders: ['19995550101'], phoneNumberId: input.phoneNumberId, clientId: api.id, revision: connection.revision }
  const saved = await put(f, admin, edit)
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().verifyToken, undefined)
  assert.equal(saved.json().connection.id, connection.id)
  assert.notEqual(saved.json().connection.revision, connection.revision)
  const rotated = (await put(f, admin, { ...edit, revision: saved.json().connection.revision, rotateVerifyToken: true })).json()
  assert.match(rotated.verifyToken, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(rotated.verifyToken, verifyToken)
  assert.equal((await disconnect(f, admin, connection.revision)).statusCode, 409)
  assert.equal((await disconnect(f, admin, rotated.connection.revision)).statusCode, 204)
  assert.equal((await get(f, admin)).json().connection, null)
  assert.notEqual((await put(f, admin, input)).json().connection.id, connection.id)
})

test('management uses live tenant permissions and a working client owned by that organization', async t => {
  const f = await fixture(t), owner = f.principal('owner'), outside = f.principal('owner')
  const viewer = f.principal('viewer', owner.tenantId), operator = f.principal('operator', owner.tenantId)
  const api = await client(f, owner), outsideClient = await client(f, outside)
  const input = setup(api)
  assert.equal((await f.gateway.inject(path)).statusCode, 401)
  for (const denied of [viewer, operator]) {
    assert.equal((await get(f, denied)).statusCode, 403)
    assert.equal((await put(f, denied, input)).statusCode, 403)
    assert.equal((await disconnect(f, denied, randomUUID())).statusCode, 403)
  }
  assert.equal((await put(f, owner, setup(outsideClient))).statusCode, 400)
  assert.equal((await put(f, owner, { ...input, clientSecret: outsideClient.clientSecret })).statusCode, 400)
  assert.equal((await put(f, owner, { ...input, senders: [] })).statusCode, 400)
  const saved = (await put(f, owner, input)).json().connection
  assert.equal((await get(f, outside)).json().connection, null)
  const reused = await put(f, outside, { ...setup(outsideClient), appSecret: input.appSecret })
  assert.equal(reused.statusCode, 409)
  assert.match(reused.json().message, /independent Meta app/)
  const independent = await put(f, outside, setup(outsideClient))
  assert.equal(independent.statusCode, 200)
  assert.notEqual(independent.json().connection.id, saved.id)
  assert.equal((await disconnect(f, outside, saved.revision)).statusCode, 409)
  const edit = { revision: saved.revision, clientId: api.id, phoneNumberId: input.phoneNumberId, senders: input.senders, version: input.version }
  const rotated = await f.gateway.inject({ method: 'POST', url: '/api/tenant/clients/' + api.id + '/rotate', headers: owner.headers })
  assert.equal(rotated.statusCode, 200)
  const stale = (await get(f, owner)).json()
  assert.equal(stale.clients[0].id, api.id)
  assert.equal(stale.connection.clientCredentialValid, false)
  assert.equal((await put(f, owner, edit)).statusCode, 400)
  const repaired = await put(f, owner, { ...edit, clientSecret: rotated.json().clientSecret })
  assert.equal(repaired.statusCode, 200)
  assert.equal((await get(f, owner)).json().connection.clientCredentialValid, true)
  await f.gateway.inject({ method: 'DELETE', url: '/api/tenant/clients/' + api.id, headers: owner.headers })
  assert.deepEqual((await get(f, owner)).json().clients, [])
  const revokedDuringUpload = new Readable({ read() {
    f.setRole(owner, 'viewer')
    this.push(JSON.stringify(edit)); this.push(null)
  } })
  const result = await f.gateway.inject({ method: 'PUT', url: path, headers: { ...owner.headers, 'content-type': 'application/json' }, payload: revokedDuringUpload })
  assert.equal(result.statusCode, 403)
})

test('connection records encrypt secrets with the persisted key and reserve trusted file-managed numbers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-config-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const storePath = join(directory, 'workspace.sqlite'), org = randomUUID()
  const input = setup({ id: randomUUID(), clientSecret: 'dss_' + randomBytes(32).toString('base64url') })
  const store = openWhatsAppConnections({ storePath })
  const { connection } = store.save(org, input, () => {})
  store.close()
  assert.equal((await stat(storePath + '.whatsapp.key')).mode & 0o777, 0o600)
  const dbBytes = await readFile(storePath + '.whatsapp-connections.sqlite')
  for (const value of [input.appSecret,input.accessToken,input.clientSecret,connection.verifyToken,...input.senders]) assert.ok(!dbBytes.includes(value))
  assert.throws(() => openWhatsAppConnections({ storePath, configuredKey: randomBytes(32).toString('base64') }), /Cannot decrypt/)
  const reserved = { bindings: new Map([['file', { phoneNumberId: '33333' }]]) }
  const reopened = openWhatsAppConnections({ storePath, legacyConfig: reserved })
  try {
    assert.equal(reopened.getById(connection.id).appSecret, input.appSecret)
    assert.throws(() => reopened.save(randomUUID(), { ...input, phoneNumberId: '33333' }, () => {}), /deployment administrator/)
  } finally { reopened.close() }
})

test('an operator file cannot take over a managed signer, even after disconnect or restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-signers-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const storePath = join(directory, 'workspace.sqlite'), org = randomUUID(), outside = randomUUID()
  const input = setup({ id: randomUUID(), clientSecret: secret() })
  const store = openWhatsAppConnections({ storePath })
  const { connection } = store.save(org, input, () => {})
  store.close()
  const legacyConfig = { appSecret: input.appSecret, bindings: new Map([
    ['first', { tenantId: org, phoneNumberId: '8822' }], ['second', { tenantId: org, phoneNumberId: '8822' }],
    ['third', { tenantId: outside, phoneNumberId: '7788' }],
  ]) }
  const conflicted = openWhatsAppConnections({ storePath, legacyConfig })
  try {
    assert.equal(conflicted.deploymentManagedNumbers(org), 1)
    assert.equal(conflicted.deploymentManagedNumbers(randomUUID()), 0)
    assert.equal(conflicted.legacySigningConflict, true)
    assert.ok(conflicted.deploymentConflict(conflicted.getByTenant(org)))
    assert.equal(conflicted.getById(connection.id), null)
    conflicted.remove(org, connection.revision)
  } finally { conflicted.close() }
  assert.throws(() => openWhatsAppConnections({ storePath, configuredKey: secret() }), /base64/)
  assert.throws(() => openWhatsAppConnections({ storePath, configuredKey: randomBytes(32).toString('base64') }), /original gateway encryption key/)
  await rename(storePath + '.whatsapp.key', storePath + '.backup-key')
  assert.throws(() => openWhatsAppConnections({ storePath }), /Restore the WhatsApp encryption key/)
  await rename(storePath + '.backup-key', storePath + '.whatsapp.key')
  const safe = openWhatsAppConnections({ storePath, legacyConfig: { ...legacyConfig, appSecret: secret() } })
  try {
    assert.equal(safe.legacySigningConflict, false)
    assert.throws(() => safe.save(outside, input, () => {}), /independent Meta app/)
    const resaved = safe.save(org, input, () => {})
    assert.equal(safe.getById(resaved.connection.id).tenantId, org)
  } finally { safe.close() }
})

test('an unused installation can adopt an operator encryption key before its first connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-unused-key-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const storePath = join(directory, 'workspace.sqlite')
  openWhatsAppConnections({ storePath }).close()
  const configuredKey = randomBytes(32).toString('base64'), tenantId = randomUUID()
  const withKey = openWhatsAppConnections({ storePath, configuredKey })
  const { connection } = withKey.save(tenantId, setup({ id: randomUUID(), clientSecret: secret() }), () => {})
  withKey.remove(tenantId, connection.revision)
  withKey.close()
  assert.throws(() => openWhatsAppConnections({ storePath }), /original gateway encryption key/)
  openWhatsAppConnections({ storePath, configuredKey }).close()
})
