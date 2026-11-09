import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID,createHash } from 'node:crypto'
import { createSupabaseStore } from '../gateway/supabase-store.mjs'
function fixture({corrupt=false,uploadFailure=false}={}) {
 const tenant=randomUUID(),subject=randomUUID(),token=randomUUID(),files=new Map(),records=new Map(),calls=[]
 const fetchImpl=async(input,options)=>{
  const url=new URL(input);calls.push(url.pathname)
  assert.equal(options.headers.apikey,'sb_publishable_test');assert.equal(options.headers.Authorization,'Bearer '+token)
  if(url.pathname==='/rest/v1/rpc/ds_document_command'){
   const {p_tenant_id,p_action,p_data}=JSON.parse(options.body);assert.equal(p_tenant_id,tenant)
   let record=records.get(p_data.id)
   if(p_action==='reserve_job'){record={...p_data,tenant_id:tenant,created_by:subject,record_type:'job',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+120000).toISOString(),object_key:tenant+'/'+p_data.id,status:'processing'};records.set(record.id,record)}
   if(p_action==='complete'){assert.equal(p_data.sha256,createHash('sha256').update(files.get(record.object_key)).digest('hex'));record.status='ready';record.sha256=p_data.sha256}
   if(p_action==='begin_delete')record.status='deleting'
   if(p_action==='finish_delete'){assert.equal(files.has(record.object_key),false);records.delete(record.id)}
   if(p_action==='fail')record.status='failed'
   return Response.json(record||null)
  }
  if(url.pathname==='/rest/v1/ds_documents'){
   assert.equal(url.searchParams.get('tenant_id'),'eq.'+tenant)
   return Response.json([...records.values()].filter(r=>!url.searchParams.has('id')||'eq.'+r.id===url.searchParams.get('id')))
  }
  const upload='/storage/v1/object/ds-documents/'
  if(url.pathname.startsWith(upload)&&options.method==='POST'){
   if(uploadFailure)return Response.json({message:'offline'},{status:503})
   assert.equal(options.headers['x-upsert'],'false');files.set(url.pathname.slice(upload.length),Buffer.from(options.body));return Response.json({})
  }
  if(url.pathname.startsWith('/storage/v1/object/authenticated/ds-documents/')){
   const bytes=files.get(url.pathname.split('/ds-documents/')[1]);return new Response(corrupt?'changed':bytes)
  }
  if(url.pathname==='/storage/v1/object/ds-documents'&&options.method==='DELETE'){
   const key=JSON.parse(options.body).prefixes[0];assert.equal([...records.values()].find(r=>r.object_key===key).status,'deleting');files.delete(key);return Response.json([])
  }
  throw new Error('Unexpected cloud request: '+url.pathname)
 }
 const scope=createSupabaseStore({supabaseUrl:'https://identity.invalid',publishableKey:'sb_publishable_test',fetchImpl}).forRequest({tenantId:tenant,subject,accessToken:token})
 return{scope,tenant,records,files,calls}
}
test('cloud documents reserve, upload immutable bytes, verify checksums, and delete storage before metadata',async()=>{
 const f=fixture(),bytes=Buffer.from('%PDF-1.7\n%%EOF')
 const result=await f.scope.uploadFile('document.pdf','PDF',bytes)
 assert.equal(result.status,'ready');assert.deepEqual((await f.scope.artifact(f.tenant,result.id)).artifact,bytes)
 assert.equal(await f.scope.deleteJob(f.tenant,result.id),true);assert.equal(f.records.size,0);assert.equal(f.files.size,0)
})
test('cloud storage errors preserve failed metadata and corrupted downloads are rejected',async()=>{
 const failed=fixture({uploadFailure:true});await assert.rejects(failed.scope.uploadFile('document.pdf','PDF',Buffer.from('%PDF-1.7')),{statusCode:503})
 assert.equal([...failed.records.values()][0].status,'failed')
 const corrupt=fixture({corrupt:true}),saved=await corrupt.scope.uploadFile('document.pdf','PDF',Buffer.from('%PDF-1.7'))
 await assert.rejects(corrupt.scope.artifact(corrupt.tenant,saved.id),{statusCode:502})
})
