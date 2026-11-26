import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const usage = 'node examples/edit-template.mjs --id UUID --base-version N [--name "New name"] [--file updated.docx] [--organization]'
const maxFileBytes = 4 * 1024 * 1024

function apiOrigin(value) {
  if (!value) throw new Error('Set DOCUSCRIPTER_ORIGIN to the gateway origin.')
  const url = new URL(value)
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error('Use HTTPS or a loopback IP address for local development.')
  if (url.username || url.password || url.href !== url.origin + '/') throw new Error('Use an origin without credentials, a path, query, or fragment.')
  return url.origin
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(40_000) })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = result?.message || result?.error || response.statusText
    throw Object.assign(new Error('HTTP ' + response.status + ' — ' + detail), { status: response.status })
  }
  if (!result) throw new Error('The gateway returned an invalid JSON response.')
  return result
}

async function editBody({ baseVersion, name, file }) {
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 1) throw new Error('Supply the positive integer version you reviewed.')
  if (name === undefined && !file) throw new Error('Supply a new name, a DOCX file, or both.')
  const body = { baseVersion }
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || [...name].length > 120) throw new Error('Supply a template name between 1 and 120 characters.')
    body.name = name.trim()
  }
  if (file) {
    const info = await stat(file)
    if (!/\.docx$/i.test(file) || !info.isFile() || !info.size || info.size > maxFileBytes) throw new Error('Choose a nonempty DOCX file up to 4 MB.')
    const bytes = await readFile(file)
    if (!bytes.length || bytes.length > maxFileBytes) throw new Error('The file size changed. Review the DOCX before submitting it.')
    body.filename = basename(file)
    body.file = bytes.toString('base64')
  }
  return body
}

// A long-running server can supply a cached token. The CLI exchanges its client credentials once per invocation.
export async function editTemplate({ origin, getAccessToken, id, baseVersion, name, file }) {
  const base = apiOrigin(origin)
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('Supply a saved template UUID.')
  const body = await editBody({ baseVersion, name, file })
  const token = await getAccessToken()
  if (!token) throw new Error('A gateway access token is required.')
  return requestJson(base + '/api/templates/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function main() {
  const { values } = parseArgs({ options: {
    id: { type: 'string' }, 'base-version': { type: 'string' }, name: { type: 'string' },
    file: { type: 'string' }, organization: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(usage); return }
  const origin = apiOrigin(process.env.DOCUSCRIPTER_ORIGIN)
  const clientId = process.env.DOCUSCRIPTER_CLIENT_ID, secret = process.env.DOCUSCRIPTER_CLIENT_SECRET
  if (!clientId || !secret) throw new Error('Set DOCUSCRIPTER_CLIENT_ID and DOCUSCRIPTER_CLIENT_SECRET in the server environment.')
  async function getAccessToken() {
    const result = await requestJson(origin + '/api/oauth/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: values.organization ? 'templates:edit:organization' : 'templates:write' }),
    })
    return result.access_token
  }
  const result = await editTemplate({ origin, getAccessToken, id: values.id, baseVersion: Number(values['base-version']), name: values.name, file: values.file })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
