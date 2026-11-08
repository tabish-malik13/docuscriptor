import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { fixture, invoiceValues } from './helpers.mjs'
import { signServiceRequest } from '../shared/service-authorization.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { validateWordFile } from '../shared/word-file.mjs'
import { buildDocxApp } from '../docx/app.mjs'
import { buildPdfApp } from '../pdf/app.mjs'

function assertion(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return 'Bearer ' + payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url')
}

test('processing services reject direct requests, tampered payloads, wrong audiences and replay', async (t) => {
  const f = await fixture(t)
  const subject = randomUUID(), body = { templateId: 'invoice', values: invoiceValues() }
  const signed = signServiceRequest(f.docxSecret, 'docx', subject, '/generate', body, randomUUID())
  assert.equal((await f.docx.inject({ method: 'POST', url: '/generate', payload: body })).statusCode, 401)
  assert.equal((await f.pdf.inject({ method: 'POST', url: '/convert', payload: {} })).statusCode, 401)
  const request = (authorization, payload = body, url = '/generate') => f.docx.inject({ method: 'POST', url, headers: { authorization }, payload })
  assert.equal((await request(signed, { ...body, values: {} })).statusCode, 401)
  assert.equal((await request(signServiceRequest(f.docxSecret, 'pdf', subject, '/generate', body, randomUUID()))).statusCode, 401)
  assert.equal((await request(signServiceRequest(f.pdfSecret, 'docx', subject, '/generate', body, randomUUID()))).statusCode, 401)
  assert.equal((await request(signed, body, '/inspect')).statusCode, 401)
  assert.equal((await request(signed)).statusCode, 200)
  assert.equal((await request(signed)).statusCode, 401)
  assert.equal((await request('Bearer malformed')).statusCode, 401)
})

test('processing services reject expired and excessive-lifetime assertions', async (t) => {
  const f = await fixture(t)
  const body = { templateId: 'invoice', values: invoiceValues() }
  const good = signServiceRequest(f.docxSecret, 'docx', randomUUID(), '/generate', body, randomUUID())
  const claims = JSON.parse(Buffer.from(good.slice(7).split('.')[0], 'base64url').toString())
  for (const exp of [Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) + 300]) {
    const auth = assertion(f.docxSecret, { ...claims, exp })
    assert.equal((await f.docx.inject({ method: 'POST', url: '/generate', headers: { authorization: auth }, payload: body })).statusCode, 401)
  }
})

test('services fail startup when secrets are absent or too short', () => {
  assert.throws(() => buildDocxApp({ secret: '' }), /32 bytes/)
  assert.throws(() => buildPdfApp({ secret: 'short' }), /32 bytes/)
  assert.throws(() => buildPdfApp({ secret: randomBytes(32).toString('hex'), rendererPassword: '' }), /GOTENBERG_PASSWORD/)
})

test('Word validation blocks macros, embedded objects and oversized ZIP expansion', async () => {
  const bytes = await starterTemplate('invoice')
  await validateWordFile(bytes)
  for (const path of ['word/vbaProject.bin', 'word/embeddings/object.bin']) {
    const zip = new PizZip(bytes)
    zip.file(path, 'unsupported')
    await assert.rejects(validateWordFile(zip.generate({ type: 'nodebuffer' })), /without macros or embedded objects/)
  }
  const zip = new PizZip(bytes)
  zip.file('word/oversized.xml', Buffer.alloc(25 * 1024 * 1024))
  await assert.rejects(validateWordFile(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })))
})

test('authentication traffic is limited before contacting the identity provider', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 120; i++) {
    assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { authorization: 'Bearer invalid' } })).statusCode, 401)
  }
  const blocked = await f.gateway.inject({ url: '/api/jobs', headers: { authorization: 'Bearer invalid' } })
  assert.equal(blocked.statusCode, 429)
  assert.ok(blocked.headers['retry-after'])
  assert.equal(f.authCalls, 120)
})

test('processing assertions require a tenant and cannot have their tenant changed', async (t) => {
  const f = await fixture(t), subject = randomUUID(), tenantId = randomUUID()
  const body = { templateId: 'invoice', values: invoiceValues() }
  const absent = signServiceRequest(f.docxSecret, 'docx', subject, '/generate', body)
  const valid = signServiceRequest(f.docxSecret, 'docx', subject, '/generate', body, tenantId)
  const [payload, signature] = valid.slice(7).split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  assert.equal(claims.tenant, tenantId)
  const tampered = 'Bearer ' + Buffer.from(JSON.stringify({ ...claims, tenant: randomUUID() })).toString('base64url') + '.' + signature
  for (const authorization of [absent, tampered]) {
    assert.equal((await f.docx.inject({ method: 'POST', url: '/generate', headers: { authorization }, payload: body })).statusCode, 401)
  }
})
