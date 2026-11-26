import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './helpers.mjs'

const settingsPath = '/api/tenant/whatsapp'
const webhook = '/api/integrations/whatsapp/webhook'
const secret = () => randomBytes(32).toString('hex')
const sender = '19995550101'
const phoneNumberId = '22334455667'

async function setup(t) {
  const sent = [], uploads = [], controls = {}
  let drain
  const options = {
    configPath: null,
    schedule(work) { drain = work; return () => {} },
    async fetchImpl(url, request) {
      assert.equal(request.method, 'POST')
      const token = request.headers.Authorization
      if (new URL(url).pathname.endsWith('/' + phoneNumberId + '/media')) {
        uploads.push(token)
        await controls.onUpload?.()
        return Response.json({ id: '81' })
      }
      assert.ok(new URL(url).pathname.endsWith('/' + phoneNumberId + '/messages'))
      sent.push({ token, content: JSON.parse(request.body) })
      return Response.json({ messages: [{ id: 'accepted' }] })
    },
  }
  const f = await fixture(t, { whatsappOptions: options })
  const update = (owner, payload) => f.gateway.inject({ method: 'PUT', url: settingsPath, headers: owner.headers, payload })
  async function connect(owner = f.principal('owner')) {
    const created = await f.gateway.inject({ method: 'POST', url: '/api/tenant/clients', headers: owner.headers,
      payload: { name: 'WhatsApp integration test', scopes: ['documents:convert'] } })
    assert.equal(created.statusCode, 201, created.body)
    const client = created.json()
    const form = { version: 'v26.0', phoneNumberId, senders: [sender], clientId: client.id }
    const appSecret = secret(), accessToken = secret()
    const response = await update(owner, { ...form, appSecret, accessToken, clientSecret: client.clientSecret, revision: null })
    assert.ok([200, 201].includes(response.statusCode), response.body)
    const { connection, verifyToken } = response.json()
    return { owner, form, client, id: connection.id, revision: connection.revision, appSecret, accessToken, verifyToken }
  }
  function message(overrides = {}, phone = phoneNumberId) {
    return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [{
        from: sender, id: randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text', text: { body: 'html <p>Workspace document</p>' }, ...overrides,
      }],
    } }] }] })
  }
  function post(connection, body, signingSecret = connection.appSecret) {
    return f.gateway.inject({ method: 'POST', url: webhook + '/' + connection.id, payload: body, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', signingSecret).update(body).digest('hex'),
    } })
  }
  const verify = (connection, token) => f.gateway.inject(webhook + '/' + connection.id + '?hub.mode=subscribe&hub.challenge=123&hub.verify_token=' + token)
  const remove = c => f.gateway.inject({ method: 'DELETE', url: settingsPath + '?revision=' + c.revision, headers: c.owner.headers })
  const saved = async person => (await f.gateway.inject({ url: settingsPath, headers: person.headers })).json().connection
  return { f, options, connect, update, remove, verify, saved, post, message, drain: () => drain(), sent, uploads, controls }
}

test('organization callbacks verify their own secret, enrollment and token and route repeated message IDs independently', async t => {
  const w = await setup(t), a = await w.connect(), b = await w.connect()
  assert.equal((await w.verify(a, b.verifyToken)).statusCode, 403)
  assert.equal((await w.verify(a, a.verifyToken)).body, '123')
  assert.ok((await w.saved(a.owner)).verifiedAt)
  assert.equal((await w.saved(b.owner)).verifiedAt, null)
  const body = w.message()
  assert.equal((await w.post(a, body, b.appSecret)).statusCode, 403)
  assert.equal((await w.post({ ...a, id: randomUUID() }, body)).statusCode, 404)
  assert.equal((await w.post(a, w.message({ from: '19995550102' }))).statusCode, 200)
  assert.equal((await w.post(a, w.message({}, '4321'))).statusCode, 200)
  await w.drain()
  assert.deepEqual(w.sent, [])
  for (const c of [a, b, a, b]) assert.equal((await w.post(c, body)).statusCode, 200)
  await w.f.restart()
  await w.f.gateway.ready()
  await w.drain()
  assert.deepEqual(w.sent.map(m => [m.token, m.content.to, m.content.type]),
    [a, b].map(c => ['Bearer ' + c.accessToken, sender, 'document']))
  for (const c of [a, b]) {
    assert.equal((await w.post(c, body)).statusCode, 200)
    const jobs = await w.f.gateway.inject({ url: '/api/jobs', headers: c.owner.headers })
    assert.deepEqual(jobs.json().items.map(job => job.createdBy), ['client:' + c.client.id])
  }
  await w.drain()
  assert.equal(w.f.rendererCalls, 2)
})

test('queued messages expire on edit or disconnect and never follow a replacement connection', async t => {
  const w = await setup(t), a = await w.connect(), b = await w.connect(), body = w.message()
  await w.post(a, body)
  await w.post(b, body)
  const newSecret = secret()
  assert.equal((await w.update(a.owner, { ...a.form, revision: a.revision, appSecret: newSecret })).statusCode, 200)
  assert.equal((await w.remove(b)).statusCode, 204)
  const replacement = await w.connect(b.owner)
  assert.notEqual(replacement.id, b.id)
  await w.drain()
  assert.equal(w.f.rendererCalls, 0)
  assert.deepEqual(w.sent, [])
  assert.equal((await w.post(a, body)).statusCode, 403)
  assert.equal((await w.post(b, body)).statusCode, 404)
  assert.equal((await w.post(a, body, newSecret)).statusCode, 200)
  await w.drain()
  assert.equal(w.f.rendererCalls, 0)
  assert.equal((await w.post(replacement, w.message())).statusCode, 200)
  await w.drain()
  assert.deepEqual(w.sent.map(m => m.token), ['Bearer ' + replacement.accessToken])
})

test('disconnect during upload prevents the worker from delivering an in-flight document', async t => {
  const w = await setup(t), c = await w.connect()
  w.controls.onUpload = async () => { assert.equal((await w.remove(c)).statusCode, 204) }
  await w.post(c, w.message())
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.equal(w.uploads.length, 1)
  assert.deepEqual(w.sent, [])
})

test('a newly installed deployment binding takes precedence over a managed callback using its phone number', async t => {
  const w = await setup(t), c = await w.connect()
  const body = w.message()
  await w.post(c, body)
  w.options.configPath = join(w.f.dir, 'whatsapp.json')
  const verifyToken = secret()
  await writeFile(w.options.configPath, JSON.stringify({ version: 'v26.0', verifyToken, appSecret: secret(), bindings: [{
    phoneNumberId, senders: [sender], tenantId: c.owner.tenantId, clientId: c.client.id,
    clientSecret: c.client.clientSecret, accessToken: secret(),
  }] }))
  await w.f.restart()
  await w.f.gateway.ready()
  assert.equal((await w.post(c, body)).statusCode, 404)
  assert.equal((await w.verify(c, c.verifyToken)).statusCode, 404)
  assert.equal((await w.f.gateway.inject(webhook + '?hub.mode=subscribe&hub.challenge=456&hub.verify_token=' + verifyToken)).body, '456')
  await w.drain()
  assert.deepEqual(w.sent, [])
  assert.equal(w.f.rendererCalls, 0)
})

test('a deployment callback cannot verify or process messages using an organization’s signing secret', async t => {
  const w = await setup(t), c = await w.connect()
  const body = w.message()
  await w.post(c, body)
  const verifyToken = secret()
  w.options.configPath = join(w.f.dir, 'operator.json')
  await writeFile(w.options.configPath, JSON.stringify({ version: 'v26.0', verifyToken, appSecret: c.appSecret, bindings: [{
    phoneNumberId: '7654321', senders: [sender], tenantId: c.owner.tenantId, clientId: c.client.id,
    clientSecret: c.client.clientSecret, accessToken: secret(),
  }] }))
  await w.f.restart()
  await w.f.gateway.ready()
  assert.equal((await w.verify(c, c.verifyToken)).statusCode, 404)
  assert.equal((await w.f.gateway.inject(webhook + '?hub.mode=subscribe&hub.challenge=456&hub.verify_token=' + verifyToken)).statusCode, 404)
  const legacyBody = w.message({}, '7654321')
  const result = await w.f.gateway.inject({ method: 'POST', url: webhook, payload: legacyBody, headers: {
    'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', c.appSecret).update(legacyBody).digest('hex'),
  } })
  assert.equal(result.statusCode, 404)
  await w.drain()
  assert.deepEqual(w.sent, [])
  assert.equal(w.f.rendererCalls, 0)
})
