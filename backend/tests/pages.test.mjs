import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { createPagesHandler } from '../../infra/cloudflare-pages-worker.mjs'

test('Pages proxies only the configured backend, preserving scope and stripping cookies', async () => {
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://preview.trycloudflare.com/api/jobs?offset=50')
    assert.equal(options.headers.get('authorization'), 'Bearer isolated-test-token')
    assert.equal(options.headers.get('x-organization-slug'), 'acme')
    assert.equal(options.headers.get('cookie'), null)
    assert.equal(options.headers.get('x-forwarded-host'), null)
    assert.equal(options.headers.get('x-hub-signature-256'), null)
    assert.equal(options.redirect, 'manual')
    return new Response('file', { headers: { 'Content-Disposition': 'attachment; filename="test.docx"', 'X-Document-Id': 'test', 'X-Template-Version': '3', 'Set-Cookie': 'unwanted=value' } })
  } })
  const result = await handler.fetch(new Request('https://app.pages.dev/api/jobs?offset=50', { headers: {
    Authorization: 'Bearer isolated-test-token', 'X-Organization-Slug': 'acme', Cookie: 'private=value', 'X-Forwarded-Host': 'evil.invalid', 'X-Hub-Signature-256': 'webhook-only',
  } }), { BACKEND_ORIGIN: 'https://preview.trycloudflare.com' })
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.headers.get('x-document-id'), 'test')
  assert.equal(result.headers.get('x-template-version'), '3')
  assert.ok(result.headers.has('content-disposition'))
  assert.equal(result.headers.get('set-cookie'), null)
})

test('Pages forwards the WhatsApp signature with exact webhook bytes and preserves OAuth cache headers', async () => {
  const path = '/api/integrations/whatsapp/webhook'
  const organizationPath = path + '/' + randomUUID()
  const body = Buffer.from('{\r\n  "text" : "Diário 📄"\r\n}\r\n')
  const sign = (bytes) => 'sha256=' + createHmac('sha256', 'transport-test').update(bytes).digest('hex')
  const env = { BACKEND_ORIGIN: 'https://preview.invalid' }
  let signatureVerified = false
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: async (url, opts) => {
    if (url.pathname === organizationPath && opts.method === 'GET') {
      assert.equal(opts.headers.get('x-hub-signature-256'), null)
      assert.equal(url.searchParams.get('hub.verify_token'), 'test-verification')
      return new Response(url.searchParams.get('hub.challenge'))
    }
    if ([path, organizationPath].includes(url.pathname)) {
      const received = new Uint8Array(await new Response(opts.body).arrayBuffer())
      signatureVerified = Buffer.from(received).equals(body) && sign(received) === opts.headers.get('x-hub-signature-256')
      return new Response(null, { status: signatureVerified ? 200 : 403 })
    }
    assert.equal(opts.headers.get('x-hub-signature-256'), null)
    return new Response('{}', { headers: { 'Content-Type': 'application/json', Pragma: 'no-cache' } })
  } })
  const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) }
  for (const endpoint of [path, organizationPath]) {
    signatureVerified = false
    const result = await handler.fetch(new Request('https://app.pages.dev' + endpoint, { method: 'POST', headers, body }), env)
    assert.equal(result.status, 200)
    assert.ok(signatureVerified)
  }
  const verification = await handler.fetch(new Request('https://app.pages.dev' + organizationPath +
    '?hub.mode=subscribe&hub.verify_token=test-verification&hub.challenge=123', { headers }), env)
  assert.equal(await verification.text(), '123')
  await handler.fetch(new Request('https://app.pages.dev' + path + '/invalid', { method: 'POST', headers, body }), env)
  const token = await handler.fetch(new Request('https://app.pages.dev/api/oauth/token', { method: 'POST' }), env)
  assert.equal(token.headers.get('cache-control'), 'no-store')
  assert.equal(token.headers.get('pragma'), 'no-cache')
})

test('Pages fails closed on missing backend, redirects, and transport errors', async () => {
  const request = new Request('https://app.pages.dev/api/jobs')
  for (const origin of [undefined, 'http://preview.invalid', 'https://user:password@preview.invalid', 'https://preview.invalid/prefix']) {
    const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: () => { throw new Error('Must not fetch') } })
    assert.equal((await handler.fetch(request, { BACKEND_ORIGIN: origin })).status, 503)
  }
  for (const fetchImpl of [async () => Response.redirect('https://evil.invalid'), async () => { throw new Error('offline') }]) {
    const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl })
    assert.equal((await handler.fetch(request, { BACKEND_ORIGIN: 'https://preview.invalid' })).status, 503)
  }
})

test('Pages preserves billing webhook bytes and forwards only the matching provider headers', async () => {
  const payload = '{\r\n "note":"₹"\r\n}'
  const headers = { 'Stripe-Signature': 'stripe-test', 'X-Razorpay-Signature': 'rzp-test', 'X-Razorpay-Event-Id': 'event-test' }
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: async (url, opts) => {
    assert.equal(await new Response(opts.body).text(), payload)
    assert.equal(opts.headers.get('Stripe-Signature'), url.pathname.endsWith('/stripe') ? 'stripe-test' : null)
    assert.equal(opts.headers.get('X-Razorpay-Signature'), url.pathname.endsWith('/razorpay') ? 'rzp-test' : null)
    assert.equal(opts.headers.get('X-Razorpay-Event-Id'), url.pathname.endsWith('/razorpay') ? 'event-test' : null)
    return new Response(null, { status: 204 })
  } })
  for (const path of ['/api/billing/webhooks/stripe', '/api/billing/webhooks/razorpay', '/api/billing/checkout']) {
    const result = await handler.fetch(new Request('https://app.pages.dev' + path, { method: 'POST', headers, body: payload }),
      { BACKEND_ORIGIN: 'https://backend.invalid' })
    assert.equal(result.status, 204)
  }
})

test('Pages forwards batch creation keys and preserves partial archive counts', async () => {
  const env = { BACKEND_ORIGIN: 'https://preview.invalid' }
  const key = '11111111-1111-4111-8111-111111111111'
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: async (url, options) => {
    assert.equal(options.headers.get('idempotency-key'), url.pathname === '/api/batches' ? key : null)
    return new Response(null, { headers: { 'X-Batch-File-Count': '2', 'X-Batch-Omitted-Count': '1' } })
  } })
  const headers = { 'Idempotency-Key': key }
  const create = await handler.fetch(new Request('https://app.pages.dev/api/batches', { method: 'POST', headers }), env)
  assert.equal(create.status, 200)
  const download = await handler.fetch(new Request('https://app.pages.dev/api/batches/' + key + '/download', { headers }), env)
  assert.equal(download.headers.get('x-batch-file-count'), '2')
  assert.equal(download.headers.get('x-batch-omitted-count'), '1')
})

test('Pages serves deep organization links and preserves separate editor policy', async () => {
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid' })
  const env = { ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } }) } }
  const workspace = await handler.fetch(new Request('https://app.pages.dev/org/acme'), env)
  assert.equal(await workspace.text(), '/')
  assert.ok(workspace.headers.get('content-security-policy').includes('https://identity.invalid'))
  for (const path of ['/editor','/editor.html','/editor.html?workspace=acme']) {
    const editor = await handler.fetch(new Request('https://app.pages.dev' + path), env)
    assert.ok(editor.headers.get('content-security-policy').includes("'wasm-unsafe-eval'"))
    assert.match(editor.headers.get('content-security-policy'), /connect-src 'self' https:\/\/identity\.invalid(?: |;)/)
    assert.equal(editor.headers.get('x-frame-options'), 'DENY')
  }
  for (const path of ['/preview','/preview.html']) {
    const preview = await handler.fetch(new Request('https://app.pages.dev' + path), env)
    assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.match(preview.headers.get('content-security-policy'), /frame-ancestors 'self'/)
    assert.ok(!preview.headers.get('content-security-policy').includes('identity.invalid'))
  }
})
