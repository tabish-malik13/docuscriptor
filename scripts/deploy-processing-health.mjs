import { spawnSync } from 'node:child_process'
const origin=process.env.PROCESSOR_ORIGIN
const url=new URL(origin)
if(url.protocol!=='https:'||!url.hostname.endsWith('.onrender.com')||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('Set PROCESSOR_ORIGIN=https://<service>.onrender.com')
const result=spawnSync('npx',['--yes','wrangler@4.158.0','deploy','--config','infra/health-worker/wrangler.jsonc','--var','PROCESSOR_ORIGIN:'+url.origin],{stdio:'inherit'})
process.exitCode=result.status||0
