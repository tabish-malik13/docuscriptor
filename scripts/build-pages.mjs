import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { organizationConfig } from '../shared/organization-url.mjs'

if (existsSync('.env')) loadEnvFile('.env')
// Use the same origin for frontend links and the gateway's APP_ORIGIN.
const origin = process.env.PUBLIC_APP_ORIGIN
if (!origin) throw new Error('Set PUBLIC_APP_ORIGIN to your actual https://<project>.pages.dev address.')
const config = organizationConfig(origin, new URL(origin).hostname, 'path')
if (!process.env.VITE_SUPABASE_URL || !process.env.VITE_SUPABASE_PUBLISHABLE_KEY) throw new Error('Configure the Supabase public URL and publishable key before building Pages.')
const supabaseOrigin = new URL(process.env.VITE_SUPABASE_URL).origin
const result = spawnSync('npm', ['run','build'], { stdio: 'inherit', env: { ...process.env,
  VITE_APP_ORIGIN: config.appOrigin, VITE_ORGANIZATION_BASE_DOMAIN: config.baseDomain, VITE_ORGANIZATION_ROUTING: 'path',
} })
if (result.status !== 0) process.exit(result.status || 1)
writeFileSync('frontend/dist/_worker.js', readFileSync('infra/cloudflare-pages-worker.mjs', 'utf8').replace("'__SUPABASE_ORIGIN__'", JSON.stringify(supabaseOrigin)))
writeFileSync('frontend/dist/_routes.json', JSON.stringify({ version: 1, include: ['/*'], exclude: ['/assets/*','/third-party-notices.txt'] }, null, 2) + '\n')
console.log('Pages artifact ready in frontend/dist. Configure BACKEND_ORIGIN as a Pages runtime variable.')
