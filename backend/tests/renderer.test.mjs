import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { buildPdfApp } from '../pdf/app.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'

const rendererUrl = process.env.GOTENBERG_TEST_URL

test('real Gotenberg rejects unauthenticated calls and converts HTML and DOCX', { skip: !rendererUrl, timeout: 90_000 }, async (t) => {
  const password = process.env.GOTENBERG_TEST_PASSWORD
  assert.ok(password, 'Set GOTENBERG_TEST_PASSWORD for the authenticated test renderer')
  let ready = false
  for (let attempt = 0; attempt < 20; attempt++) {
    try { ready = (await fetch(rendererUrl + '/health', { signal: AbortSignal.timeout(2000) })).ok } catch { /* starting */ }
    if (ready) break
    await setTimeout(1000)
  }
  assert.ok(ready, 'Gotenberg did not become healthy')
  const direct = await fetch(rendererUrl + '/forms/chromium/convert/html', { method: 'POST' })
  assert.equal(direct.status, 401)
  await direct.body?.cancel()
  const secret = randomBytes(32).toString('hex')
  const app = buildPdfApp({ secret, rendererUrl, rendererPassword: password, logger: false })
  t.after(() => app.close())
  for (const [filename, bytes] of [
    ['input.html', Buffer.from('<!doctype html><html><body><h1>Conversion verification</h1></body></html>')],
    ['input.docx', await starterTemplate('invoice')],
  ]) {
    const payload = { filename, file: bytes.toString('base64') }
    const response = await app.inject({ method: 'POST', url: '/convert', payload,
      headers: { authorization: signServiceRequest(secret, 'pdf', randomUUID(), '/convert', payload, randomUUID()) } })
    assert.equal(response.statusCode, 200, response.body)
    assert.ok(response.rawPayload.length > 1000)
    assert.equal(response.rawPayload.subarray(0, 5).toString(), '%PDF-')
  }
})
