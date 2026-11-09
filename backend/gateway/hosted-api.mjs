import { forwardProcessing, processingOrigin } from './processing-proxy.mjs'
// Serverless gateway: organization management and private files only.
// Processing services remain separately deployable and are deliberately not called here.
import { Buffer } from 'node:buffer'
import { createTenantAuthority, uuidPattern } from './tenant-authority.mjs'
import { createSupabaseStore } from './supabase-store.mjs'
import { validOrganizationSlug } from '../../shared/organization-url.mjs'
import { problem } from '../../shared/problems.mjs'

const admin = new Set(['owner','admin'])
const operator = new Set(['owner','admin','operator'])
const roles = new Set(['owner','admin','operator','viewer'])
const json = (data,status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
async function readBytes(request,max) {
  if (Number(request.headers.get('content-length'))>max) throw problem(413,'This file is too large. Upload a file of 4 MB or smaller.')
  const chunks=[]; let size=0
  for await(const chunk of request.body || []) {
    size+=chunk.length
    if(size>max) throw problem(413,'This upload is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks,size)
}
async function body(request) {
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw problem(400,'Send a JSON request.')
  try { const data=JSON.parse((await readBytes(request,32*1024)).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw problem(400,'Invalid request body.');return data } catch(error) { if(error.statusCode)throw error;throw problem(400,'Invalid request body.') }
}
function text(value,max) { if(typeof value!=='string'||!value.trim()||value.length>max)throw problem(400,'Check the required name and fields.');return value.trim() }
function uuid(value) { if(typeof value!=='string'||!uuidPattern.test(value))throw problem(400,'Invalid record identifier.');return value.toLowerCase() }
export function createHostedApi({supabaseOrigin,publishableKey,fetchImpl=fetch,authority,store,processorOrigin}={}) {
  const processor = processingOrigin(processorOrigin)
  authority ||= createTenantAuthority({supabaseUrl:supabaseOrigin,publishableKey,fetchImpl})
  store ||= createSupabaseStore({supabaseUrl:supabaseOrigin,publishableKey,fetchImpl})
  return async function hostedApi(request) {
    const path=new URL(request.url).pathname,method=request.method
    if(path==='/api/health'&&method==='GET')return json({status:'ok',storage:'supabase',processing:!!processor})
    try {
      const [scheme,token,extra]=(request.headers.get('authorization')||'').split(' ')
      if(scheme!=='Bearer'||!token||extra!==undefined||token.length>8192)throw problem(401,'Sign in to continue.')
      let user
      try {
        const response=await fetchImpl(new URL('/auth/v1/user',supabaseOrigin),{headers:{apikey:publishableKey,Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)})
        if(response.status===401||response.status===403)throw problem(401,'Your session is invalid or expired.')
        if(!response.ok)throw Object.assign(new Error('Identity unavailable'),{providerStatus:response.status})
        user=await response.json()
      } catch(error) { if(error.statusCode)throw error;console.warn('Identity lookup unavailable',{name:error.name,providerStatus:error.providerStatus,illegalInvocation:!!error.message?.includes('Illegal invocation')});throw problem(503,'Authentication is temporarily unavailable.') }
      if(!user||user.is_anonymous||user.aud!=='authenticated'||!uuidPattern.test(user.id)||!user.email_confirmed_at||typeof user.email!=='string'||!user.email)throw problem(403,'A verified account is required.')
      const identity={subject:user.id,accessToken:token,email:user.email.toLowerCase(),tenantId:null,tenantRole:null}
      if(path==='/api/organizations') {
        if(method==='GET')return json({items:await authority.list(token,user.id)})
        if(method==='POST') {
          const data=await body(request)
          if(!validOrganizationSlug(data.slug))throw problem(400,'Choose a valid organization workspace address.')
          return json(await authority.create(token,text(data.name,120),data.slug),201)
        }
      }
      if(path==='/api/invitations'&&method==='GET')return json({items:await authority.invitations(token,null,identity.email)})
      const accept=/^\/api\/invitations\/([^/]+)\/accept$/.exec(path)
      if(accept&&method==='POST')return json({tenantId:await authority.accept(token,uuid(accept[1]))})
      if(path==='/api/personal-records'&&method==='GET')return json({jobs:0,templates:0})
      identity.tenantId=uuid(request.headers.get('x-tenant-id'))
      const slug=request.headers.get('x-organization-slug')
      if(!validOrganizationSlug(slug))throw problem(400,'Open an organization workspace first.')
      identity.tenantRole=await authority.membership(token,identity.tenantId,user.id,slug)
      if(!identity.tenantRole)throw problem(403,'You do not have access to this organization.')
      identity.canProcess=operator.has(identity.tenantRole)
      const requireAdmin=()=>{if(!admin.has(identity.tenantRole))throw problem(403,'Organization administrator access is required.')}
      const requireOperator=()=>{if(!identity.canProcess)throw problem(403,'Your organization role cannot change saved files.')}
      const db=store.forRequest(identity)
      if(['/api/docx/generate','/api/pdf/convert','/api/templates'].includes(path)&&method==='POST') {
        requireOperator()
        if(!processor)throw problem(501,'Document generation, template processing, and PDF conversion are not supported in this hosted version.')
        const payload=await readBytes(request,6*1024*1024)
        return forwardProcessing(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:payload}),{...identity,organizationSlug:slug},{origin:processor,fetchImpl})
      }
      if(path==='/api/jobs'&&method==='GET') {
        const offset=new URL(request.url).searchParams.get('offset')||'0'
        if(!/^(0|[1-9][0-9]{0,4})$/.test(offset))throw problem(400,'Invalid page offset.')
        const items=await db.listJobs(identity.tenantId,Number(offset))
        return json({items,nextOffset:items.length===50?Number(offset)+50:null})
      }
      if(path==='/api/files'&&method==='POST') {
        requireOperator()
        let name
        try{name=decodeURIComponent(request.headers.get('x-file-name')||'')}catch{throw problem(400,'Invalid filename.')}
        name=text(name,200)
        const bytes=await readBytes(request,4*1024*1024)
        const kind=/\.docx$/i.test(name)?'DOCX':/\.pdf$/i.test(name)?'PDF':null
        if(!kind||!(kind==='PDF'?bytes.subarray(0,5).equals(Buffer.from('%PDF-')):bytes.subarray(0,2).equals(Buffer.from('PK'))))throw problem(422,'Upload a DOCX or PDF file matching its filename.')
        return json(await db.uploadFile(name,kind,bytes),201)
      }
      if(path==='/api/templates'&&method==='GET')return json({items:await db.listTemplates(identity.tenantId)})
      const document=/^\/api\/(jobs|templates)\/([^/]+)(\/download)?$/.exec(path)
      if(document) {
        const [,type,rawId,download]=document,id=uuid(rawId)
        if(method==='DELETE'&&!download) {
          requireOperator()
          const removed=await (type==='jobs'?db.deleteJob(identity.tenantId,id):db.deleteTemplate(identity.tenantId,id))
          if(!removed)throw problem(404,'Document not found.')
          return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}})
        }
        if(method==='GET'&&download) {
          const file=await (type==='jobs'?db.artifact(identity.tenantId,id):db.template(identity.tenantId,id))
          if(!file)throw problem(404,'Document not found or not ready.')
          const filename=type==='jobs'?file.name:file.name+'.docx'
          return new Response(file.artifact||file.file,{headers:{'Content-Type':file.kind==='PDF'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition':`attachment; filename="${filename.replace(/[^a-zA-Z0-9._ -]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,
            'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
        }
        if(method==='GET'&&type==='jobs') {const record=await db.job(identity.tenantId,id);if(!record)throw problem(404,'Document not found.');return json(record)}
      }
      if(path==='/api/tenant/membership'&&method==='GET')return json({role:identity.tenantRole,userId:user.id})
      if(path==='/api/tenant'&&method==='PATCH') {requireAdmin();await authority.rename(token,identity.tenantId,text((await body(request)).name,120));return new Response(null,{status:204})}
      if(path==='/api/tenant/leave'&&method==='POST') {await authority.setRole(token,identity.tenantId,user.id,null);return new Response(null,{status:204})}
      if(path==='/api/tenant/members'&&method==='GET') {requireAdmin();return json({items:await authority.members(token,identity.tenantId)})}
      const member=/^\/api\/tenant\/members\/([^/]+)$/.exec(path)
      if(member&&['PATCH','DELETE'].includes(method)) {
        requireAdmin();const role=method==='DELETE'?null:(await body(request)).role
        if(role!==null&&!roles.has(role))throw problem(400,'Choose a valid organization role.')
        await authority.setRole(token,identity.tenantId,uuid(member[1]),role);return new Response(null,{status:204})
      }
      if(path==='/api/tenant/invitations') {
        requireAdmin()
        if(method==='GET')return json({items:await authority.invitations(token,identity.tenantId)})
        if(method==='POST') {
          const data=await body(request),email=text(data.email,254)
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['admin','operator','viewer'].includes(data.role))throw problem(400,'Check the invitation email and role.')
          return json({id:await authority.invite(token,identity.tenantId,email,data.role)},201)
        }
      }
      const invitation=/^\/api\/tenant\/invitations\/([^/]+)$/.exec(path)
      if(invitation&&method==='DELETE') {requireAdmin();await authority.revoke(token,identity.tenantId,uuid(invitation[1]));return new Response(null,{status:204})}
      if(path==='/api/tenant/audit'&&method==='GET') {requireAdmin();return json({items:await authority.audit(token,identity.tenantId)})}
      throw problem(404,'This workspace operation is unavailable.')
    }catch(error){return json({message:error.publicMessage||'The workspace request could not be completed.'},error.statusCode||500)}
  }
}
