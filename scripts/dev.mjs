import { spawn, spawnSync } from 'node:child_process'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
if (existsSync(root + '.env')) loadEnvFile(root + '.env')
const children = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => stop())
async function listening(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
    const value = await response.json()
    return ['ok','unavailable'].includes(value.status)
  } catch { return false }
}
function launch(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
  children.add(child)
  child.once('error', (error) => { console.error(error.message); stop(1) })
  child.once('exit', (code) => { children.delete(child); if (!stopping) stop(code || 1) })
  return child
}
try {
  if (!process.env.DEV_GATEWAY_URL) {
  if (!process.env.GOTENBERG_URL) {
    const docker = spawnSync('docker', ['info','--format','{{.ServerVersion}}'], { stdio: 'ignore', timeout: 5000 })
    if (docker.status === 0) {
      const renderer = spawnSync('docker', ['compose','-p','docuscripter-native','-f','compose.yaml','-f','compose.dev.yaml','up','-d','renderer'], { cwd: root, stdio: 'inherit', env: process.env, timeout: 45000 })
      if (renderer.status !== 0) console.warn('The PDF renderer did not start. The workspace and Word generation can still run.')
    } else console.warn('Start Docker for PDF conversion. The workspace and Word generation can still run.')
  }
  for (const [name, port, path] of [['gateway',4000,'/api/health'],['docx',4001,'/health'],['pdf',4002,'/health']]) {
    const url = 'http://127.0.0.1:' + port + path
    if (await listening(url)) { console.log('Using the running ' + name + ' service on port ' + port + '.'); continue }
    launch(['--watch', 'backend/' + name + '/server.mjs'], { ...process.env, HOST: '127.0.0.1', PORT: String(port) })
    let ready = false
    for (let attempt = 0; attempt < 20 && !stopping; attempt++) {
      if (await listening(url)) { ready = true; break }
      await setTimeout(250)
    }
    if (!ready) throw new Error('The ' + name + ' service did not start. Check the preceding configuration error.')
  }
  } else console.log('Using the configured development gateway.')
  if (!stopping) launch(['node_modules/vite/bin/vite.js', '--config', 'frontend/vite.config.ts'])
} catch (error) { console.error(error.message); stop(1) }
