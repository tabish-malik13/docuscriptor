import { createHostedApi } from '../backend/gateway/hosted-api.mjs'
// Cloudflare Pages advanced-mode entry point. No server credentials are bundled.
const editorPolicy = "default-src 'self'; connect-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
// Workers support manual/follow redirects. Reject redirects explicitly so bearer
// credentials can never be forwarded to a different origin.
export async function cloudFetch(input, options = {}) {
  const response = await globalThis.fetch(input, { ...options, redirect:'manual' })
  if(response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new Error('Upstream redirects are not allowed.')
  }
  return response
}
export function createPagesHandler({ supabaseOrigin, publishableKey, fetchImpl = cloudFetch, processorOrigin }) {
  const workspacePolicy = `default-src 'self'; connect-src 'self' ${supabaseOrigin}; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  const api = createHostedApi({ supabaseOrigin, publishableKey, fetchImpl, processorOrigin })
  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      let response
      if (url.pathname.startsWith('/api/')) {
        const result = await api(request)
        const headers = new Headers(result.headers)
        headers.set('Cache-Control','no-store'); headers.set('X-Content-Type-Options','nosniff')
        return new Response(result.body,{status:result.status,headers})
      }
      if (url.pathname === '/org' || url.pathname.startsWith('/org/')) {
        url.pathname = '/'
        response = await env.ASSETS.fetch(new Request(url, request))
      } else response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', ['/editor.html','/editor'].includes(url.pathname) ? editorPolicy : workspacePolicy)
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set('X-Frame-Options', 'DENY')
      return new Response(response.body, { status: response.status, headers })
    },
  }
}

export default { fetch(request,env) { return createPagesHandler({ supabaseOrigin: '__SUPABASE_ORIGIN__', publishableKey: '__SUPABASE_PUBLISHABLE_KEY__', processorOrigin: env.PROCESSOR_ORIGIN }).fetch(request,env) } }
