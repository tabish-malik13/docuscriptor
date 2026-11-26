import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createService } from '../shared/http-service.mjs'

test('service logs and routing errors omit webhook query credentials, headers and payloads', async (t) => {
  const records = []
  const stream = new Writable({ write(chunk, _encoding, callback) { records.push(JSON.parse(chunk)); callback() } })
  const app = createService({ logger: { level: 'trace', stream } })
  t.after(() => app.close())
  const webhook = '/api/integrations/whatsapp/webhook'
  app.post(webhook, async () => ({ ok: true }))
  const query = '?hub.verify_token=marker-query'
  const privateHeaders = { authorization: 'Bearer marker-access', 'x-hub-signature-256': 'marker-hmac' }
  assert.equal((await app.inject({ method: 'POST', url: webhook + query, headers: privateHeaders,
    payload: { text: 'marker-body' } })).statusCode, 200)
  // Exercise both unregistered/mistyped webhook URLs and errors rejected by the router.
  for (const [path, expected] of [[webhook + '/', 404], ['/api/%', 400]]) {
    const response = await app.inject({ url: path + query, headers: privateHeaders })
    assert.equal(response.statusCode, expected)
    assert.doesNotMatch(response.body, /marker-/)
  }
  const parseError = Object.assign(new Error('marker-http-message'), { code: 'HPE_INVALID_HEADER_TOKEN', rawPacket: 'marker-packet' })
  // Node HTTP client errors carry a copy of the raw HTTP request into Fastify's trace log.
  app.server.emit('clientError', parseError, { writable: false, destroyed: false, destroy() {} })
  assert.ok(records.some((entry) => entry.req?.route === webhook))
  assert.ok(records.some((entry) => entry.err?.code === 'HPE_INVALID_HEADER_TOKEN'))
  assert.ok(records.some((entry) => entry.res?.statusCode === 404))
  assert.doesNotMatch(JSON.stringify(records), /marker-/)
})
