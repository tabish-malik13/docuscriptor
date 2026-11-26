import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { buildPdfApp } from '../pdf/app.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import PizZip from 'pizzip'
import { fixture } from './helpers.mjs'

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

  const f = await fixture(t, { renderer: { url: rendererUrl, password, fetchImpl: fetch } })
  const { headers } = f.principal()
  const rows = ['00041', '00042'].map((id) => ({ name: id, values: {
    recipient_name: 'Recipient ' + id, course_name: 'Document processing', completion_date: '2026-11-26',
    issuer_name: 'Integration test', certificate_id: id,
  } }))
  const create = await f.gateway.inject({ method: 'POST', url: '/api/batches', headers, payload: { templateId: 'certificate', format: 'PDF', rows } })
  assert.equal(create.statusCode, 201, create.body)
  const path = '/api/batches/' + create.json().id
  for (let i = 0; i < rows.length; i++) {
    const next = await f.gateway.inject({ method: 'POST', url: path + '/next', headers })
    assert.equal(next.statusCode, 200, next.body)
    assert.equal(next.json().ready, i + 1)
  }
  const download = await f.gateway.inject({ method: 'GET', url: path + '/download', headers })
  assert.equal(download.statusCode, 200)
  const zip = new PizZip(download.rawPayload)
  assert.deepEqual(Object.keys(zip.files), rows.map(row => row.name + '.pdf'))
  for (const entry of Object.values(zip.files)) assert.equal(entry.asNodeBuffer().subarray(0, 5).toString(), '%PDF-')
})
