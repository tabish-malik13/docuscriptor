import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { organizationConfig } from '../shared/organization-url.mjs'
import { setTimeout } from 'node:timers/promises'

if (existsSync('.env')) loadEnvFile('.env')
if (!process.env.PUBLIC_APP_ORIGIN) throw new Error('Set PUBLIC_APP_ORIGIN=https://<actual-project>.pages.dev before starting the preview.')
const origin = process.env.PUBLIC_APP_ORIGIN
organizationConfig(origin, new URL(origin).hostname, 'path')
if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('Install the open-source cloudflared CLI first. See docs/deployment.md.')
const env = { ...process.env, PUBLIC_ORGANIZATION_ROUTING: 'path', PUBLIC_ORGANIZATION_BASE_DOMAIN: new URL(origin).hostname }
const args = ['compose','-p','docuscripter-preview','-f','compose.yaml','-f','compose.preview.yaml']
const build = spawnSync('docker', [...args,'up','--build','-d','web'], { env, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status || 1)
let ready = false
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const health = await fetch('http://127.0.0.1:4173/api/health', { signal: AbortSignal.timeout(2000) })
    ready = health.ok && (await health.json()).status === 'ok'
    if (ready) break
  } catch { /* The web container may still be starting after Compose returns. */ }
  await setTimeout(500)
}
if (!ready) throw new Error('The preview gateway is not healthy.')
mkdirSync('.data', { recursive: true, mode: 0o700 })
// Never reuse a stale URL after a restart; Quick Tunnel URLs change each time.
writeFileSync('.data/preview.json', JSON.stringify({ appOrigin: origin, backendOrigin: null }) + '\n', { mode: 0o600 })
const tunnel = spawn('cloudflared', ['tunnel','--no-autoupdate','--url','http://127.0.0.1:4173'], { stdio: ['ignore','pipe','pipe'] })
let output = '', announced = false
function receive(chunk) {
  process.stderr.write(chunk)
  output = (output + chunk.toString()).slice(-8000)
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  if (match && !announced) {
    announced = true
    writeFileSync('.data/preview.json', JSON.stringify({ appOrigin: origin, backendOrigin: match[0] }) + '\n', { mode: 0o600 })
    console.log('\nSet Cloudflare Pages BACKEND_ORIGIN to: ' + match[0] + '\nKeep this command and Docker running. Ctrl+C stops the public tunnel.\n')
  }
}
tunnel.stdout.on('data', receive)
tunnel.stderr.on('data', receive)
tunnel.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
tunnel.on('exit', (code) => { process.exitCode = code || 0 })
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => tunnel.kill('SIGTERM'))
