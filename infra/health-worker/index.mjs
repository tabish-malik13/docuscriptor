export async function checkProcessor(origin,{fetchImpl=fetch}={}) {
  const url=new URL(origin)
  if(url.protocol!=='https:'||!url.hostname.endsWith('.onrender.com')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Set PROCESSOR_ORIGIN to the Render service HTTPS origin.')
  const response=await fetchImpl(new URL('/api/health',url),{method:'GET',redirect:'manual',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(85_000)})
  if(!response.ok||!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw new Error('Processing health check failed: '+response.status)}
  const health=await response.json()
  if(health.status!=='ok')throw new Error('Processing service is not ready.')
  return true
}
export default {
  async scheduled(_event,env){await checkProcessor(env.PROCESSOR_ORIGIN);console.log('Processing health check passed.')},
  fetch(){return new Response('Not found',{status:404})},
}
