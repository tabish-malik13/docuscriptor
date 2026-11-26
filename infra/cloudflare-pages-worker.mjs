// Cloudflare Pages advanced-mode entry point. No server credentials are bundled.
export function createPagesHandler({ supabaseOrigin, fetchImpl = fetch }) {
  const editorPolicy = `default-src 'self'; connect-src 'self' ${supabaseOrigin} data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  const previewPolicy = "default-src 'self'; connect-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
  const workspacePolicy = `default-src 'self'; connect-src 'self' ${supabaseOrigin}; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  const unavailable = () => Response.json({ message: 'The preview backend is offline. Start the local preview and update its tunnel address.' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      let response
      if (url.pathname.startsWith('/api/')) {
        try {
          const backend = new URL(env.BACKEND_ORIGIN)
          if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) return unavailable()
          const headers = new Headers()
          for (const name of ['authorization','content-type','x-tenant-id','x-organization-slug']) {
            if (request.headers.has(name)) headers.set(name, request.headers.get(name))
          }
          const whatsappCallback = /^\/api\/integrations\/whatsapp\/webhook(?:\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})?$/i
          if (request.method === 'POST' && whatsappCallback.test(url.pathname) && request.headers.has('x-hub-signature-256')) {
            headers.set('x-hub-signature-256', request.headers.get('x-hub-signature-256'))
          }
          if (request.method === 'POST' && url.pathname === '/api/billing/webhooks/stripe' && request.headers.has('stripe-signature')) {
            headers.set('stripe-signature', request.headers.get('stripe-signature'))
          }
          if (request.method === 'POST' && url.pathname === '/api/billing/webhooks/razorpay') {
            for (const name of ['x-razorpay-signature', 'x-razorpay-event-id']) {
              if (request.headers.has(name)) headers.set(name, request.headers.get(name))
            }
          }
          if (request.method === 'POST' && url.pathname === '/api/batches' && request.headers.has('idempotency-key')) {
            headers.set('idempotency-key', request.headers.get('idempotency-key'))
          }
          const timeout = /^\/api\/batches\/[^/]+\/next$/.test(url.pathname) ? 90_000 : 40_000
          response = await fetchImpl(new URL(url.pathname + url.search, backend), {
            method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : request.body,
            redirect: 'manual', signal: AbortSignal.timeout(timeout), duplex: 'half',
          })
          // Never follow a redirect carrying a user's bearer token to another host.
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unavailable() }
        } catch { return unavailable() }
        const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        for (const name of ['content-type','content-disposition','x-document-id','x-template-version','x-batch-file-count','x-batch-omitted-count','retry-after','www-authenticate','pragma']) {
          if (response.headers.has(name)) headers.set(name, response.headers.get(name))
        }
        return new Response(response.body, { status: response.status, headers })
      }
      if (url.pathname === '/org' || url.pathname.startsWith('/org/')) {
        url.pathname = '/'
        response = await env.ASSETS.fetch(new Request(url, request))
      } else response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      const preview = ['/preview.html','/preview'].includes(url.pathname)
      headers.set('Content-Security-Policy', preview ? previewPolicy : ['/editor.html','/editor'].includes(url.pathname) ? editorPolicy : workspacePolicy)
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set('X-Frame-Options', preview ? 'SAMEORIGIN' : 'DENY')
      return new Response(response.body, { status: response.status, headers })
    },
  }
}

export default createPagesHandler({ supabaseOrigin: '__SUPABASE_ORIGIN__' })
