import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagesHandler } from '../../infra/cloudflare-pages-worker.mjs'
const options={supabaseOrigin:'https://identity.invalid',publishableKey:'sb_publishable_test'}
test('Pages runs the hosted API without a PC backend or tunnel',async()=>{
 const handler=createPagesHandler({...options,fetchImpl:()=>{throw new Error('Must not fetch for health or unauthenticated requests')}})
 const health=await handler.fetch(new Request('https://app.pages.dev/api/health'),{})
 assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok',storage:'supabase',processing:false})
 const denied=await handler.fetch(new Request('https://app.pages.dev/api/jobs'),{})
 assert.equal(denied.status,401);assert.equal(denied.headers.get('cache-control'),'no-store')
})
test('Pages serves deep organization links and preserves separate editor policy',async()=>{
 const handler=createPagesHandler(options)
 const env={ASSETS:{fetch:async(request)=>new Response(new URL(request.url).pathname,{headers:{'Content-Type':'text/html'}})}}
 const workspace=await handler.fetch(new Request('https://app.pages.dev/org/isolated-org'),env)
 assert.equal(await workspace.text(),'/');assert.ok(workspace.headers.get('content-security-policy').includes('https://identity.invalid'))
 for(const path of ['/editor','/editor.html']) {
  const editor=await handler.fetch(new Request('https://app.pages.dev'+path),env)
  assert.ok(editor.headers.get('content-security-policy').includes("'wasm-unsafe-eval'"));assert.equal(editor.headers.get('x-frame-options'),'DENY')
 }
})

test('Workers use supported manual redirects and reject credential-bearing redirects',async(t)=>{
 const {cloudFetch}=await import('../../infra/cloudflare-pages-worker.mjs')
 const mocked=t.mock.method(globalThis,'fetch',async(_input,options)=>{
  assert.equal(options.redirect,'manual')
  return Response.redirect('https://unexpected.invalid')
 })
 await assert.rejects(cloudFetch('https://identity.invalid',{redirect:'error',headers:{Authorization:'Bearer isolated-test-token'}}),/redirects are not allowed/)
 assert.equal(mocked.mock.callCount(),1)
})
