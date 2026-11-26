import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { openInbox } from '../whatsapp/inbox.mjs'
import { clientScopes } from '../gateway/client-credentials.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { fixture, invoiceValues } from './helpers.mjs'

const path = '/api/integrations/whatsapp/webhook'
const secret = () => randomBytes(32).toString('hex')

async function setup(t, scopes = clientScopes, normalStartup = false, fixtureOptions = {}) {
  const whatsappOptions = { configPath: null }
  const f = await fixture(t, { ...fixtureOptions, whatsappOptions }), owner = f.principal('owner')
  const created = await f.gateway.inject({ method: 'POST', url: '/api/tenant/clients', headers: owner.headers, payload: { name: 'Integration under test', scopes } })
  assert.equal(created.statusCode, 201, created.body)
  const client = created.json()
  const phoneNumberId = '22334455667', from = '19995550101'
  const binding = { phoneNumberId, senders: [from], tenantId: owner.tenantId, accessToken: secret(), clientId: client.id, clientSecret: client.clientSecret }
  const config = { verifyToken: secret(), appSecret: secret(), version: 'v26.0', bindings: [binding] }
  const storePath = join(f.dir, 'workspace.sqlite'), configPath = join(f.dir, 'whatsapp.json')
  const input = await starterTemplate('invoice'), mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?id=42'
  let now = Date.now(), drain
  const controls = { url: mediaUrl, size: input.length, failUpload: false, ambiguousSend: false }
  const calls = [], deliveries = []
  async function fetchImpl(url, options) {
    calls.push(url)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer ' + binding.accessToken)
    if (url.endsWith('/42?phone_number_id=' + phoneNumberId)) return Response.json({ id: '42', file_size: String(controls.size), url: controls.url, sha256: createHash('sha256').update(input).digest('hex') })
    if (url === mediaUrl) return new Response(input)
    if (url.endsWith('/' + phoneNumberId + '/media')) {
      if (controls.failUpload) return new Response(null, { status: 503 })
      if (controls.onUpload) await controls.onUpload()
      const bytes = Buffer.from(await options.body.get('file').arrayBuffer())
      assert.ok(bytes.subarray(0, 5).toString() === '%PDF-' || bytes.subarray(0, 2).toString() === 'PK')
      return Response.json({ id: '81' })
    }
    if (url.endsWith('/' + phoneNumberId + '/messages')) {
      if (controls.throttleSend) return new Response(null, { status: 429, headers: { 'retry-after': '5' } })
      deliveries.push(JSON.parse(options.body))
      if (controls.ambiguousSend) throw new Error('Provider receipt lost')
      return Response.json({ messages: [{ id: 'accepted' }] })
    }
    throw new Error('Unexpected external request')
  }
  async function restart() {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const options = { configPath, storePath, fetchImpl, now: () => now }
    if (!normalStartup) options.schedule = (work) => { drain = work; return () => {} }
    Object.assign(whatsappOptions, options)
    await f.restart()
    await f.gateway.ready()
  }
  function event(msg, phone = phoneNumberId) {
    const message = { from, id: randomUUID(), timestamp: String(Math.floor(now / 1000)), ...msg }
    return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages: [message],
    } }] }] })
  }
  function submit(body, signed = body) {
    return f.gateway.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', config.appSecret).update(signed).digest('hex') }, payload: body })
  }
  function tokenCount() {
    const db = new DatabaseSync(storePath, { readOnly: true })
    try { return db.prepare('SELECT count(*) AS n FROM api_access_tokens WHERE client_id=?').get(binding.clientId).n }
    finally { db.close() }
  }
  await restart()
  return { tokenCount, f, owner, binding, config, controls, calls, deliveries, event, submit, restart, drain: () => drain(), advance: (ms = 65_000) => { now += ms } }
}

const attachment = (caption) => ({ type: 'document', document: { id: '42', filename: 'invoice.docx', caption } })

test('WhatsApp verifies the raw body, callback token, sender, recipient and message age before doing work', async (t) => {
  const w = await setup(t)
  const verify = path + '?hub.mode=subscribe&hub.challenge=4321&hub.verify_token='
  assert.equal((await w.f.gateway.inject(verify + w.config.verifyToken)).body, '4321')
  assert.equal((await w.f.gateway.inject(verify + 'incorrect')).statusCode, 403)
  const body = w.event(attachment('pdf'))
  assert.equal((await w.submit(' ' + body, body)).statusCode, 403)
  for (const denied of [w.event({ ...attachment(), from: '19995550102' }), w.event(attachment(), '123'), w.event({ ...attachment(), timestamp: '1' })]) {
    assert.equal((await w.submit(denied)).statusCode, 200)
  }
  await w.drain()
  assert.deepEqual(w.calls, [])
})

test('a signed DOCX delivery goes through OAuth, conversion, storage and Meta, once across retries and restarts', async (t) => {
  const w = await setup(t, ['documents:convert']), body = w.event(attachment('pdf'))
  assert.equal((await w.submit(body)).statusCode, 200)
  assert.equal((await w.submit(body)).statusCode, 200)
  await w.drain()
  assert.deepEqual(w.deliveries.map((d) => [d.to, d.type, d.document?.filename]), [[w.binding.senders[0], 'document', 'invoice.pdf']])
  const history = await w.f.gateway.inject({ url: '/api/jobs', headers: w.owner.headers })
  assert.deepEqual(history.json().items.map((j) => [j.status, j.createdBy]), [['ready', 'client:' + w.binding.clientId]])
  assert.equal(w.f.rendererCalls, 1)
  await w.restart()
  await w.submit(body)
  await w.drain()
  assert.equal(w.deliveries.length, 1)
  assert.equal(w.f.rendererCalls, 1)
  await w.submit(w.event({ type: 'text', text: { body: 'html <h1>Quarterly report</h1>' } }))
  await w.drain()
  assert.equal(w.deliveries.at(-1).document.filename, 'document.pdf')
  await w.submit(w.event({ type: 'text', text: { body: 'jobs' } }))
  await w.drain()
  assert.match(w.deliveries.at(-1).text.body, /does not have access/)
})

test('saved templates, fields, generation, history, downloads and creator-only deletion use gateway permissions', async (t) => {
  const w = await setup(t)
  async function command(msg) {
    const body = w.event(typeof msg === 'string' ? { type: 'text', text: { body: msg } } : msg)
    assert.equal((await w.submit(body)).statusCode, 200)
    await w.drain()
    return w.deliveries.at(-1)
  }
  const saved = await command(attachment('save Billing')),
    templateId = saved.text.body.split(' ').at(-1)
  assert.match((await command('templates')).text.body, /Billing/)
  assert.match((await command('fields ' + templateId)).text.body, /invoice_number/)
  assert.equal((await command('template ' + templateId)).document.filename, 'Billing.docx')
  assert.equal((await command('generate ' + templateId + ' ' + JSON.stringify(invoiceValues()))).document.filename, 'Billing.docx')
  const id = (await command('jobs')).text.body.split(' ')[0]
  assert.match((await command('job ' + id)).text.body, /ready/)
  assert.equal((await command('download ' + id)).document.filename, 'Billing.docx')
  assert.equal((await command('delete job ' + id)).text.body, 'Deleted.')
  assert.equal((await command('delete template ' + templateId)).text.body, 'Deleted.')
  const peer = w.f.principal('operator')
  const other = await w.f.gateway.inject({ method: 'POST', url: '/api/docx/generate', headers: peer.headers,
    payload: { templateId: 'invoice', values: invoiceValues() } })
  assert.match((await command('download ' + other.headers['x-document-id'])).text.body, /not found/i)
})

test('media fetches stay on Meta and stop before conversion on large files or invalid addresses', async (t) => {
  const w = await setup(t)
  w.controls.size = 4 * 1024 * 1024 + 1
  await w.submit(w.event(attachment()))
  await w.drain()
  w.controls.size = 20
  w.controls.url = 'https://outside.invalid/media'
  await w.submit(w.event(attachment()))
  await w.drain()
  assert.equal(w.f.rendererCalls, 0)
  assert.equal(w.deliveries.length, 2)
  assert.ok(w.calls.every((url) => url.startsWith('https://graph.facebook.com/')))
})

test('failed uploads retry by saved job ID, and revoked credentials block redelivery after restart', async (t) => {
  const w = await setup(t)
  w.controls.failUpload = true
  await w.submit(w.event(attachment()))
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.equal(w.deliveries.length, 0)
  const revoked = await w.f.gateway.inject({ url: '/api/tenant/clients/' + w.binding.clientId, method: 'DELETE', headers: w.owner.headers })
  assert.equal(revoked.statusCode, 204)
  await w.restart()
  w.controls.failUpload = false
  w.advance()
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.deepEqual(w.deliveries.map((d) => d.type), ['text'])
  assert.match(w.deliveries[0].text.body, /does not have access/)
})

test('a pending event cannot follow a remapped sender and an ambiguous send cannot send twice', async (t) => {
  const w = await setup(t)
  const event = w.event(attachment())
  await w.submit(event)
  const tenant = w.binding.tenantId
  w.binding.tenantId = randomUUID()
  await w.restart()
  await w.drain()
  assert.deepEqual(w.calls, [])
  w.binding.tenantId = tenant
  await w.restart()
  const fresh = w.event(attachment())
  w.controls.ambiguousSend = true
  await w.submit(fresh)
  await w.drain()
  await w.restart()
  await w.submit(fresh)
  w.advance()
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.equal(w.deliveries.length, 1)
})

test('a phone-hidden WhatsApp user can use an enrolled business-scoped ID and replies target that exact ID', async (t) => {
  const w = await setup(t, ['documents:convert']), userId = 'IN.' + randomBytes(10).toString('hex')
  w.binding.senders = [userId]
  await w.restart()
  await w.submit(w.event({ ...attachment(), from: undefined, from_user_id: userId }))
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.equal(w.deliveries[0].recipient, userId)
  assert.equal(w.deliveries[0].to, undefined)
})

test('an enabled gateway automatically processes verified events with its background worker', async (t) => {
  const w = await setup(t, ['documents:generate'], true)
  const body = w.event({ type: 'text', text: { body: 'generate invoice ' + JSON.stringify(invoiceValues()) } })
  assert.equal((await w.submit(body)).statusCode, 200)
  const deadline = Date.now() + 5000
  while (!w.deliveries.length && Date.now() < deadline) await delay(50)
  assert.equal(w.deliveries[0]?.document.filename, 'Invoice.docx')
})

test('a full inbox accepts the rest of a retried batch as slots become available', (t) => {
  const inbox = openInbox(':memory:')
  t.after(() => inbox.close())
  const events = Array.from({ length: 501 }, (_, i) => ({ phoneNumberId: '1', id: String(i) }))
  assert.equal(inbox.enqueue(events, 1), false)
  const first = inbox.next(1)
  inbox.finish(first.key, 'sent')
  assert.equal(inbox.enqueue(events, 2), true)
  let received = 1, row
  while ((row = inbox.next(2))) {
    assert.equal(row.event.id, String(received++))
    inbox.finish(row.key, 'sent')
  }
  assert.equal(received, 501)
})

test('the worker reuses a token per binding and requested scope until its renewal window', async (t) => {
  const w = await setup(t)
  async function send(text) {
    await w.submit(w.event({ type: 'text', text: { body: text } }))
    await w.drain()
  }
  for (let i = 0; i < 8; i++) await send('jobs')
  assert.equal(w.tokenCount(), 1)
  await send('templates')
  await send('templates')
  assert.equal(w.tokenCount(), 2)
  w.advance(890_000)
  await send('jobs')
  assert.equal(w.tokenCount(), 3)
  assert.equal(w.deliveries.length, 11)
})

test('secret rotation suppresses a cached template receipt until the updated secret is installed', async (t) => {
  const w = await setup(t, ['templates:write'])
  w.controls.throttleSend = true
  await w.submit(w.event(attachment('save Enrolled template')))
  await w.drain()
  assert.equal(w.tokenCount(), 1)
  const rotated = await w.f.gateway.inject({ method: 'POST', url: '/api/tenant/clients/' + w.binding.clientId + '/rotate', headers: w.owner.headers })
  assert.equal(rotated.statusCode, 200)
  w.controls.throttleSend = false
  w.advance()
  await w.drain()
  assert.match(w.deliveries[0].text.body, /does not have access/)
  assert.doesNotMatch(w.deliveries[0].text.body, /Saved template/)
  assert.equal(w.tokenCount(), 0)
  w.binding.clientSecret = rotated.json().clientSecret
  await w.restart()
  await w.submit(w.event(attachment('save Another template')))
  await w.drain()
  assert.match(w.deliveries[1].text.body, /^Saved template /)
})

test('revocation while uploading an authorized file suppresses the outgoing file message', async (t) => {
  const w = await setup(t, ['documents:convert'])
  w.controls.onUpload = async () => {
    const revoked = await w.f.gateway.inject({ method: 'DELETE', url: '/api/tenant/clients/' + w.binding.clientId, headers: w.owner.headers })
    assert.equal(revoked.statusCode, 204)
  }
  await w.submit(w.event(attachment()))
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.deepEqual(w.deliveries.map((entry) => entry.type), ['text'])
  assert.match(w.deliveries[0].text.body, /does not have access/)
})

test('gateway 503 admission retries after its delay and commits a single PDF using the same token', { timeout: 5000 }, async (t) => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  let started = 0
  const w = await setup(t, ['documents:convert'], false, { onServiceResult: async () => {
    if (++started === 4) entered.resolve()
    await release.promise
  } })
  const teams = [w.f.principal(), w.f.principal()]
  const inFlight = Array.from({ length: 4 }, (_, i) => w.f.gateway.inject({ method: 'POST', url: '/api/docx/generate',
    headers: teams[i % 2].headers, payload: { templateId: 'invoice', values: invoiceValues() } }))
  try {
    await entered.promise
    await w.submit(w.event(attachment()))
    await w.drain()
    assert.equal(w.f.rendererCalls, 0)
    assert.equal(w.deliveries.length, 0)
    const calls = w.calls.length
    w.advance(1000)
    await w.drain()
    assert.equal(w.calls.length, calls)
  } finally {
    release.resolve()
    await Promise.all(inFlight)
  }
  w.advance(1000)
  await w.drain()
  assert.equal(w.f.rendererCalls, 1)
  assert.equal(w.deliveries[0].document.filename, 'invoice.pdf')
  assert.equal(w.tokenCount(), 1)
  const jobs = await w.f.gateway.inject({ url: '/api/jobs', headers: w.owner.headers })
  assert.equal(jobs.json().items.length, 1)
})
