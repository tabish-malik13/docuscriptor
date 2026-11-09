import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createHostedApi } from '../gateway/hosted-api.mjs'
function setup({role='operator',authFailure=false,unverified=false}={}) {
  const subject=randomUUID(),tenant=randomUUID(),token=randomUUID();let uploads=0,processing=0
  const api=createHostedApi({supabaseOrigin:'https://identity.invalid',publishableKey:'sb_publishable_test',
    fetchImpl:async(url,options)=>{
      assert.equal(new URL(url).pathname,'/auth/v1/user','Hosted API never forwards processing requests')
      if(authFailure)throw new Error('offline')
      if(options.headers.Authorization!=='Bearer '+token)return Response.json({}, {status:401})
      return Response.json({id:subject,aud:'authenticated',email:'isolated@test.invalid',email_confirmed_at:unverified?null:'2026-01-01'})
    },
    authority:{membership:async(_token,id,user,slug)=>id===tenant&&user===subject&&slug==='isolated-org'?role:null,list:async()=>[],create:async()=>({id:tenant})},
    store:{forRequest(identity){assert.equal(identity.subject,subject);assert.equal(identity.tenantId,tenant);return {
      listJobs:async()=>[],listTemplates:async()=>[],uploadFile:async(name,kind,bytes)=>{uploads++;assert.equal(name,'document.pdf');assert.equal(kind,'PDF');assert.ok(bytes.toString().startsWith('%PDF-'));return{id:randomUUID(),status:'ready'}},
      beginJob:async()=>{processing++;throw new Error('Must not run')},
    }}},
  })
  const headers={Authorization:'Bearer '+token,'X-Tenant-Id':tenant,'X-Organization-Slug':'isolated-org'}
  const call=(path,options={})=>api(new Request('https://app.pages.dev'+path,{...options,headers:{...headers,...options.headers}}))
  return{api,call,headers,get uploads(){return uploads},get processing(){return processing}}
}
test('hosted processing stays disabled for authorized users; missing or revoked scope fails closed',async()=>{
 const f=setup()
 for(const path of ['/api/docx/generate','/api/pdf/convert','/api/templates'])assert.equal((await f.call(path,{method:'POST'})).status,501)
 assert.equal(f.processing,0)
 assert.equal((await f.call('/api/jobs',{headers:{'X-Organization-Slug':'another-org'}})).status,403)
 assert.equal((await f.call('/api/jobs',{headers:{'X-Tenant-Id':randomUUID()}})).status,403)
 assert.equal((await f.api(new Request('https://app.pages.dev/api/files',{method:'POST'}))).status,401)
 assert.equal((await setup({role:null}).call('/api/jobs')).status,403)
})
test('hosted API accepts bounded raw document uploads but rejects viewer writes and invalid file signatures',async()=>{
 const f=setup(),options={method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':'document.pdf'},body:'%PDF-1.7\n%%EOF'}
 assert.equal((await f.call('/api/files',options)).status,201);assert.equal(f.uploads,1)
 assert.equal((await f.call('/api/files',{...options,body:'invalid'})).status,422)
 assert.equal((await f.call('/api/files',{...options,headers:{...options.headers,'Content-Length':String(5*1024*1024)}})).status,413)
 assert.equal((await setup({role:'viewer'}).call('/api/files',options)).status,403)
 assert.equal((await setup({role:'viewer'}).call('/api/jobs')).status,200)
})
test('hosted API verifies real identity responses and validates account inputs',async()=>{
 assert.equal((await setup({unverified:true}).call('/api/organizations')).status,403)
 assert.equal((await setup({authFailure:true}).call('/api/organizations')).status,503)
 const f=setup()
 assert.equal((await f.call('/api/organizations',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'})).status,400)
 assert.equal((await f.call('/api/organizations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Organization',slug:'api'})})).status,400)
 assert.equal((await f.call('/api/jobs?offset=-1')).status,400)
})
