import test from 'node:test'
import assert from 'node:assert/strict'
import {forwardProcessing,processingOrigin}from'../gateway/processing-proxy.mjs'
import{checkProcessor}from'../../infra/health-worker/index.mjs'
test('processor wakes before the single processing POST and receives verified scope only',async()=>{
 let health=0,posts=0,time=0
 const identity={accessToken:'isolated-token',tenantId:'isolated-tenant',organizationSlug:'isolated-org'}
 const result=await forwardProcessing(new Request('https://app.pages.dev/api/pdf/convert',{method:'POST',body:'{}'}),identity,{
  origin:'https://isolated.onrender.com',now:()=>time,wait:async(ms)=>{time+=ms},fetchImpl:async(url,options)=>{
   if(url.endsWith('/api/health')){health++;assert.equal(options.headers.Authorization,undefined);return health===1?new Response('Waking',{status:503}):Response.json({status:'ok'})}
   posts++;assert.equal(options.headers.Authorization,'Bearer isolated-token');assert.equal(options.headers['X-Tenant-Id'],'isolated-tenant');assert.equal(options.headers.Cookie,undefined);assert.equal(options.redirect,'manual')
   return new Response('%PDF-1.7',{headers:{'Content-Type':'application/pdf','X-Document-Id':'isolated-id','Set-Cookie':'unwanted=value'}})
  },
 })
 assert.equal(health,2);assert.equal(posts,1);assert.equal(await result.text(),'%PDF-1.7');assert.equal(result.headers.get('set-cookie'),null);assert.equal(result.headers.get('x-document-id'),'isolated-id')
})
test('cold or redirecting processors fail without retrying a processing POST',async()=>{
 let posts=0,time=0
 await assert.rejects(forwardProcessing(new Request('https://app.pages.dev/api/pdf/convert',{method:'POST',body:'{}'}),{}, {
  origin:'https://isolated.onrender.com',wakeTimeoutMs:10,now:()=>time,wait:async(ms)=>{time+=ms},fetchImpl:async(_url,options)=>{if(options.method==='POST')posts++;return new Response('Waking',{status:503})},
 }),{statusCode:503});assert.equal(posts,0)
 await assert.rejects(forwardProcessing(new Request('https://app.pages.dev/api/pdf/convert',{method:'POST',body:'{}'}),{}, {origin:'https://isolated.onrender.com',fetchImpl:async()=>Response.redirect('https://unexpected.invalid')}),{statusCode:502})
 assert.throws(()=>processingOrigin('http://insecure.invalid'))
})
test('scheduled health requests are bounded, uncredentialed, and validate readiness',async()=>{
 await checkProcessor('https://isolated.onrender.com',{fetchImpl:async(url,options)=>{assert.equal(url.pathname,'/api/health');assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');return Response.json({status:'ok'})}})
 await assert.rejects(checkProcessor('https://isolated.onrender.com',{fetchImpl:async()=>new Response('Loading',{status:503})}))
 await assert.rejects(checkProcessor('https://not-render.invalid'))
})
