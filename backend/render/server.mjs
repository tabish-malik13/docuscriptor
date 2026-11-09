// A small-instance deployment profile. The three HTTP apps remain independently
// deployable; here they share one Node runtime and private loopback listeners.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildGatewayApp } from '../gateway/app.mjs'
import { buildDocxApp } from '../docx/app.mjs'
import { buildPdfApp } from '../pdf/app.mjs'

process.umask(0o077)
const docxSecret=randomBytes(32).toString('hex'),pdfSecret=randomBytes(32).toString('hex'),rendererPassword=randomBytes(32).toString('hex')
const apps=[]
let stopping=false
const renderer=spawn('/usr/bin/gotenberg',[
  '--api-bind-ip=127.0.0.1','--api-port=3000','--api-enable-basic-auth','--api-body-limit=6MB','--api-timeout=25s',
  '--api-disable-download-from','--webhook-disable',
  '--chromium-auto-start=false','--libreoffice-auto-start=false',
  '--chromium-max-concurrency=1','--chromium-max-queue-size=1','--libreoffice-max-queue-size=1',
  '--chromium-idle-shutdown-timeout=10s','--libreoffice-idle-shutdown-timeout=10s',
  '--chromium-disable-javascript','--chromium-deny-private-ips','--chromium-deny-public-ips',
  '--libreoffice-enable-macros=false','--libreoffice-deny-private-ips','--libreoffice-deny-public-ips',
],{stdio:'inherit',env:{...process.env,GOMAXPROCS:'1',GOMEMLIMIT:'96MiB',GOTENBERG_API_BASIC_AUTH_USERNAME:'docuscripter',GOTENBERG_API_BASIC_AUTH_PASSWORD:rendererPassword}})
async function stop(code=0){
  if(stopping)return
  stopping=true
  const force=globalThis.setTimeout(()=>process.exit(code||1),10_000);force.unref()
  await Promise.allSettled(apps.map(app=>app.close()))
  renderer.kill('SIGTERM')
  process.exitCode=code
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void stop()})
renderer.once('error',()=>{console.error('The private renderer did not start.');void stop(1)})
renderer.once('exit',(code)=>{if(!stopping){console.error('The private renderer stopped.');void stop(code||1)}})
const rendererHeaders={Authorization:'Basic '+Buffer.from('docuscripter:'+rendererPassword).toString('base64')}
async function rendererReady(){
  try {const r=await fetch('http://127.0.0.1:3000/health',{headers:rendererHeaders,signal:AbortSignal.timeout(2000)});await r.body?.cancel();return r.ok}catch{return false}
}
try{
  let ready=false
  for(let attempt=0;attempt<45&&!stopping;attempt++){if(await rendererReady()){ready=true;break}await delay(500)}
  if(!ready)throw new Error('The private renderer is not ready.')
  const docx=buildDocxApp({secret:docxSecret}),pdf=buildPdfApp({secret:pdfSecret,rendererPassword,rendererUrl:'http://127.0.0.1:3000'})
  apps.push(docx,pdf)
  await docx.listen({host:'127.0.0.1',port:4001});await pdf.listen({host:'127.0.0.1',port:4002})
  const gateway=await buildGatewayApp({docxSecret,pdfSecret,docxService:'http://127.0.0.1:4001',pdfService:'http://127.0.0.1:4002',processingLimit:1,healthCheck:rendererReady})
  apps.push(gateway)
  await gateway.listen({host:'0.0.0.0',port:Number(process.env.PORT||10000)})
}catch(error){console.error(error.message);await stop(1)}
