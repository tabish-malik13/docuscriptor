import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagesHandler } from '../../infra/cloudflare-pages-worker.mjs'

test('Pages proxies only the configured backend, preserving scope and stripping cookies', async () => {
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid', fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://preview.trycloudflare.com/api/jobs?offset=50')
    assert.equal(options.headers.get('authorization'), 'Bearer isolated-test-token')
    assert.equal(options.headers.get('x-organization-slug'), 'acme')
    assert.equal(options.headers.get('cookie'), null)
    assert.equal(options.headers.get('x-forwarded-host'), null)
    assert.equal(options.redirect, 'manual')
    return new Response('file', { headers: { 'Content-Disposition': 'attachment; filename="test.docx"', 'X-Document-Id': 'test', 'Set-Cookie': 'unwanted=value' } })
  } })
  const result = await handler.fetch(new Request('https://app.pages.dev/api/jobs?offset=50', { headers: {
    Authorization: 'Bearer isolated-test-token', 'X-Organization-Slug': 'acme', Cookie: 'private=value', 'X-Forwarded-Host': 'evil.invalid',
  } }), { BACKEND_ORIGIN: 'https://preview.trycloudflare.com' })
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.headers.get('x-document-id'), 'test')
  assert.ok(result.headers.has('content-disposition'))
  assert.equal(result.headers.get('set-cookie'), null)
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

test('Pages serves deep organization links and preserves separate editor policy', async () => {
  const handler = createPagesHandler({ supabaseOrigin: 'https://identity.invalid' })
  const env = { ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } }) } }
  const workspace = await handler.fetch(new Request('https://app.pages.dev/org/acme'), env)
  assert.equal(await workspace.text(), '/')
  assert.ok(workspace.headers.get('content-security-policy').includes('https://identity.invalid'))
  for (const path of ['/editor','/editor.html']) {
    const editor = await handler.fetch(new Request('https://app.pages.dev' + path), env)
    assert.ok(editor.headers.get('content-security-policy').includes("'wasm-unsafe-eval'"))
    assert.equal(editor.headers.get('x-frame-options'), 'DENY')
  }
})
