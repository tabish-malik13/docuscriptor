import { problem } from '../../shared/problems.mjs'
import { readArtifact } from '../shared/document-http.mjs'

export function processingOrigin(value) {
  if(!value)return null
  const url=new URL(value)
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Configure a valid HTTPS processing origin.')
  return url.origin
}
export async function forwardProcessing(request,identity,{origin,fetchImpl=fetch,now=Date.now,wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms)),wakeTimeoutMs=90_000}={}) {
  const target=processingOrigin(origin)
  if(!target)throw problem(501,'Document processing has not been configured.')
  // Wake first; never retry a generation POST because it could create duplicates.
  const deadline=now()+wakeTimeoutMs
  let ready=false
  for(let attempt=0;attempt<20&&now()<deadline;attempt++) {
    try {
      const response=await fetchImpl(target+'/api/health',{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(75_000,deadline-now()))),headers:{'Cache-Control':'no-cache'}})
      if(response.ok&&response.headers.get('content-type')?.includes('application/json'))ready=(await response.json()).status==='ok'
      else await response.body?.cancel()
      if(ready)break
      if(response.status>=300&&response.status<400)throw problem(502,'The processor address redirected. Check its configuration.')
    }catch(error){if(error.publicMessage)throw error}
    if(now()<deadline)await wait(Math.min(4000,deadline-now()))
  }
  if(!ready)throw problem(503,'The converter is waking up or temporarily unavailable. Please retry shortly.')
  let response
  try {
    response=await fetchImpl(target+new URL(request.url).pathname,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(50_000),
      headers:{Authorization:'Bearer '+identity.accessToken,'Content-Type':'application/json','X-Tenant-Id':identity.tenantId,'X-Organization-Slug':identity.organizationSlug},body:request.body,duplex:'half'})
  }catch{throw problem(503,'The processing request could not finish. Check Activity before submitting again.')}
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw problem(502,'The processor address redirected. Check its configuration.')}
  const type=response.headers.get('content-type')||''
  if(!type.includes('application/json')&&!type.includes('application/pdf')&&!type.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
    await response.body?.cancel();throw problem(503,'The converter is waking up or temporarily unavailable. Please retry shortly.')
  }
  const bytes=await readArtifact(response)
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
  for(const name of ['content-type','content-disposition','x-document-id','retry-after','www-authenticate'])if(response.headers.has(name))headers.set(name,response.headers.get(name))
  return new Response(bytes,{status:response.status,headers})
}
