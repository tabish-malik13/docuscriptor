import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'
import { rateLimitOptions, rateLimitTrustedProxies, registerGatewayRateLimits } from '../gateway/rate-limits.mjs'

function gateway(t, { options, now, storePath = ':memory:', trustProxy = false } = {}) {
  const app = Fastify({ trustProxy })
  registerGatewayRateLimits(app, { storePath, options, now })
  const credentials = new Map()
  const accepted = async (request) => {
    const identity = credentials.get(request.headers.authorization)
    if (!identity) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    Object.assign(request, identity)
  }
  const ok = async () => ({ ok: true })
  app.get('/api/health', ok)
  app.get('/api/jobs', { onRequest: accepted }, ok)
  app.post('/api/convert', { onRequest: accepted }, ok)
  app.post('/api/upload', { onRequest: accepted }, ok)
  app.post('/api/docx/preview', { onRequest: accepted, config: { rateClass: 'preview', rateLimit: { max: 1 } } }, ok)
  app.post('/api/token', { config: { rateClass: 'token' } }, ok)
  app.post('/api/webhook', { config: { rateClass: 'webhook' } }, ok)
  app.post('/api/session', { config: { rateLimit: { max: 1 } } }, ok)
  t.after(() => app.close())
  return {
    app,
    credential(tenantId = randomUUID(), subject = randomUUID()) {
      const authorization = randomUUID()
      credentials.set(authorization, { subject, tenantId })
      return { authorization }
    },
  }
}

test('verified subject and shared tenant limits are atomic across concurrent requests', async (t) => {
  const { app, credential } = gateway(t, { options: { subject: 1, tenant: 2 } })
  const tenant = randomUUID(), subject = randomUUID()
  const read = (headers) => app.inject({ url: '/api/jobs', headers })
  const actor = credential(tenant, subject)
  const burst = await Promise.all(Array.from({ length: 5 }, () => read(actor)))
  assert.deepEqual(burst.map((r) => r.statusCode).sort(), [200, 429, 429, 429, 429])
  // Another verified subject retains a place in the tenant budget.
  assert.equal((await read(credential(tenant))).statusCode, 200)
  assert.equal((await read(credential(tenant))).statusCode, 429)
  assert.equal((await read(credential(randomUUID(), subject))).statusCode, 200)
  assert.equal((await read({ ...actor, 'x-tenant-id': randomUUID() })).statusCode, 429)
})

test('writes share limits across document routes while reads stay available', async (t) => {
  const { app, credential } = gateway(t, { options: { write: 1, tenantWrite: 2 } })
  const tenant = randomUUID(), actor = credential(tenant)
  const write = (url, headers) => app.inject({ method: 'POST', url, headers })
  assert.equal((await write('/api/upload', actor)).statusCode, 200)
  assert.equal((await write('/api/convert', actor)).statusCode, 429)
  assert.equal((await write('/api/convert', credential(tenant))).statusCode, 200)
  assert.equal((await write('/api/upload', credential(tenant))).statusCode, 429)
  assert.equal((await app.inject({ url: '/api/jobs', headers: actor })).statusCode, 200)
})

test('live document previews have their own cap and leave the mutation budget available', async (t) => {
  const { app, credential } = gateway(t, { options: { write: 1, tenantWrite: 1 } })
  const headers = credential()
  const post = url => app.inject({ method: 'POST', url, headers })
  assert.equal((await post('/api/docx/preview')).statusCode, 200)
  assert.equal((await post('/api/docx/preview')).statusCode, 429)
  assert.equal((await post('/api/convert')).statusCode, 200)
  assert.equal((await post('/api/convert')).statusCode, 429)
})

test('source, token, webhook and health traffic have independent admission', async (t) => {
  const { app } = gateway(t, { options: { ip: 1, token: 1, webhook: 1 } })
  const post = (url) => app.inject({ method: 'POST', url })
  assert.equal((await app.inject('/api/jobs')).statusCode, 401)
  assert.equal((await app.inject('/api/jobs')).statusCode, 429)
  for (const route of ['/api/token','/api/webhook']) {
    assert.equal((await post(route)).statusCode, 200)
    assert.equal((await post(route)).statusCode, 429)
  }
  assert.equal((await app.inject('/api/health')).statusCode, 200)
})

test('route-level limits still protect anonymous session exchange', async (t) => {
  const { app } = gateway(t)
  for (const status of [200, 429]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/session' })).statusCode, status)
  }
})

test('source IP trusts only configured proxies and groups IPv6 by /64', async (t) => {
  const { app } = gateway(t, { options: { ip: 1 }, trustProxy: rateLimitTrustedProxies({ RATE_LIMIT_TRUSTED_PROXIES: '127.0.0.10/32' }) })
  const read = (remoteAddress, forwarded) => app.inject({ url: '/api/jobs', remoteAddress, headers: { 'x-forwarded-for': forwarded } })
  assert.equal((await read('127.0.0.11', '192.0.2.1')).statusCode, 401)
  assert.equal((await read('127.0.0.11', '192.0.2.2')).statusCode, 429)
  assert.equal((await read('127.0.0.10', '2001:db8:1:2::1')).statusCode, 401)
  assert.equal((await read('127.0.0.10', '2001:db8:1:2::2')).statusCode, 429)
  assert.equal((await read('127.0.0.10', '2001:db8:1:3::1')).statusCode, 401)
  assert.equal((await read('127.0.0.10', '::ffff:192.0.2.1')).statusCode, 401)
  assert.equal((await read('127.0.0.10', '192.0.2.1')).statusCode, 429)
})

test('SQLite quotas survive reopening, return the actual retry delay, and purge expired keys', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-limits-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storePath = join(dir, 'workspace.sqlite')
  let time = 100_000
  const config = { now: () => time, storePath, options: { ip: 1 } }
  const first = gateway(t, config)
  assert.equal((await first.app.inject('/api/jobs')).statusCode, 401)
  await first.app.close()
  time += 12_001
  const reopened = gateway(t, config)
  const denied = await reopened.app.inject('/api/jobs')
  assert.equal(denied.statusCode, 429)
  assert.equal(denied.headers['retry-after'], '48')
  time += 60_000
  assert.equal((await reopened.app.inject({ url: '/api/jobs', remoteAddress: '192.0.2.7' })).statusCode, 401)
  const db = new DatabaseSync(storePath + '.limits.sqlite', { readOnly: true })
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM buckets').get().n, 1) }
  finally { db.close() }
})

test('rate limit configuration rejects invalid values and broad proxy trust', () => {
  assert.equal(rateLimitOptions({ RATE_LIMIT_IP_PER_MINUTE: '225' }).ip, 225)
  for (const value of ['', '-1', '0', '10.5', 'Infinity', '1e3']) {
    assert.throws(() => rateLimitOptions({ RATE_LIMIT_IP_PER_MINUTE: value }), /RATE_LIMIT_IP_PER_MINUTE/)
  }
  assert.equal(rateLimitTrustedProxies({}), false)
  assert.deepEqual(rateLimitTrustedProxies({ RATE_LIMIT_TRUSTED_PROXIES: '127.0.0.1, 2001:db8::1/128' }), ['127.0.0.1','2001:db8::1/128'])
  for (const value of ['true', '0.0.0.0/0', '192.0.2.0/33', '::/129']) {
    assert.throws(() => rateLimitTrustedProxies({ RATE_LIMIT_TRUSTED_PROXIES: value }), /RATE_LIMIT_TRUSTED_PROXIES/)
  }
})

test('a busy rate counter database rejects work and recovers after the lock clears', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-limits-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storePath = join(dir, 'workspace.sqlite')
  const { app, credential } = gateway(t, { storePath })
  const headers = credential()
  const other = new DatabaseSync(storePath + '.limits.sqlite')
  try {
    other.exec('BEGIN IMMEDIATE')
    const blocked = await app.inject({ url: '/api/jobs', headers })
    assert.equal(blocked.statusCode, 503)
    assert.equal(blocked.headers['retry-after'], '1')
    assert.equal((await app.inject('/api/health')).statusCode, 200)
    other.exec('ROLLBACK')
    assert.equal((await app.inject({ url: '/api/jobs', headers })).statusCode, 200)
  } finally { other.close() }
})
