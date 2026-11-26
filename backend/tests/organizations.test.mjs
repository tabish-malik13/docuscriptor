import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fixture } from './helpers.mjs'
import { canonicalDirectoryUrl, organizationConfig, organizationUrl, organizationSlugFromHost, organizationSlugFromPath, validOrganizationSlug } from '../../shared/organization-url.mjs'

const config = organizationConfig('http://127.0.0.1:5173', 'docuscriptor.localhost')
const challenge = (value) => createHash('sha256').update(value).digest('base64url')
async function link(f, person, verifier) {
  return f.gateway.inject({ method: 'POST', url: '/api/auth/workspace-link', headers: { ...person.headers, origin: config.appOrigin },
    payload: { organizationId: person.tenantId, refreshToken: randomBytes(32).toString('hex'), challenge: challenge(verifier), state: randomUUID() } })
}
function exchange(f, url, verifier, override = {}) {
  const target = new URL(url)
  return f.gateway.inject({ method: 'POST', url: '/api/auth/workspace-session', headers: { host: target.host, origin: target.origin, ...override },
    payload: { code: new URLSearchParams(target.hash.slice(1)).get('workspace-code'), verifier } })
}

test('sign-out closes the shared browser session, refreshed tokens and outstanding handoffs across gateway restarts', async t => {
  const f = await fixture(t), owner = f.principal('owner'), sessionId = randomUUID()
  const directory = f.browserSession(owner, sessionId), workspace = f.browserSession(owner, sessionId)
  const otherDevice = f.browserSession(owner)
  const get = (url, person) => f.gateway.inject({ url, headers: person.headers })
  const verifier = randomBytes(32).toString('base64url')
  const pending = await link(f, directory, verifier)
  assert.equal(pending.statusCode, 200)
  assert.equal((await get('/api/auth/session', workspace)).json().id, owner.user.id)
  const exit = await f.gateway.inject({ method: 'POST', url: '/api/auth/sign-out', headers: directory.headers })
  assert.equal(exit.statusCode, 204)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/auth/sign-out', headers: workspace.headers })).statusCode, 204)
  assert.equal((await exchange(f, pending.json().url, verifier)).statusCode, 401)
  await f.restart()
  for (const person of [directory, workspace, f.browserSession(owner, sessionId)]) {
    for (const path of ['/api/auth/session', '/api/organizations', '/api/jobs']) {
      assert.equal((await get(path, person)).statusCode, 401)
    }
  }
  assert.equal((await get('/api/jobs', otherDevice)).statusCode, 200)
  assert.equal((await get('/api/auth/session', f.browserSession(owner))).statusCode, 200)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/auth/sign-out' })).statusCode, 401)
})

test('opaque legacy credentials can sign out without changing another session for the same user', async t => {
  const f = await fixture(t), owner = f.principal('owner'), another = f.browserSession(owner)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/auth/sign-out', headers: owner.headers })).statusCode, 204)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: owner.headers })).statusCode, 401)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: another.headers })).statusCode, 200)
})

test('workspace addresses are unique subdomains; reserved and malformed labels are rejected', () => {
  for (const slug of ['acme','my-company','org123']) assert.equal(validOrganizationSlug(slug), true)
  for (const slug of ['www','api','auth','ab','evil.com','-acme','acme-','Acme','a'.repeat(41)]) assert.equal(validOrganizationSlug(slug), false, slug)
  assert.equal(organizationUrl('acme', config), 'http://acme.docuscriptor.localhost:5173/')
  const production = organizationConfig('https://docuscriptor.com','docuscriptor.com')
  assert.equal(organizationUrl('acme', production), 'https://acme.docuscriptor.com/')
  assert.equal(organizationSlugFromHost('acme.docuscriptor.com', production), 'acme')
  assert.equal(organizationSlugFromHost('docuscriptor.com', production), null)
  assert.equal(organizationSlugFromHost('docuscriptor.com.evil.invalid', production), null)
  assert.throws(() => organizationSlugFromHost('nested.acme.docuscriptor.com', production))
  assert.throws(() => organizationConfig('http://docuscriptor.com','docuscriptor.com'))
})

test('provider-hosted workspaces use validated organization paths', () => {
  const paths = organizationConfig('https://docuscriptor.pages.dev', 'docuscriptor.pages.dev', 'path')
  assert.equal(organizationUrl('acme', paths), 'https://docuscriptor.pages.dev/org/acme')
  assert.equal(organizationSlugFromPath('/org/acme'), 'acme')
  assert.equal(organizationSlugFromPath('/org/acme/'), 'acme')
  assert.equal(organizationSlugFromPath('/'), null)
  for (const path of ['/org','/org/','/org/api','/org/Acme','/org/acme/nested','/org/%61cme']) assert.throws(() => organizationSlugFromPath(path))
  assert.throws(() => organizationConfig('https://docuscriptor.pages.dev','docuscriptor.pages.dev','invalid'))
})

test('known directory aliases enter the configured session origin and preserve the requested view', () => {
  for (const alias of ['localhost', '[::1]', 'docuscriptor.localhost']) {
    assert.equal(canonicalDirectoryUrl('http://' + alias + ':5173/editor.html?workspace=acme#templates', config),
      config.appOrigin + '/editor.html?workspace=acme#templates')
  }
  const paths = organizationConfig('http://localhost:5173', 'docuscriptor.localhost', 'path')
  assert.equal(canonicalDirectoryUrl('http://127.0.0.1:5173/org/acme#activity', paths), paths.appOrigin + '/org/acme#activity')
  for (const url of [config.appOrigin, organizationUrl('acme', config), 'http://localhost:4173', 'https://localhost:5173', 'http://unrelated.invalid:5173']) {
    assert.equal(canonicalDirectoryUrl(url, config), null)
  }
  const live = organizationConfig('https://app.example.org', 'example.org')
  assert.equal(canonicalDirectoryUrl('https://example.org/', live), 'https://app.example.org/')
  assert.equal(canonicalDirectoryUrl('https://localhost/', live), null)
  assert.equal(canonicalDirectoryUrl('https://acme.example.org/', live), null)
})

test('the native development proxy retains the browser Host used to verify workspace sign-in tickets', async () => {
  const { loadConfigFromFile } = await import('vite')
  const path = fileURLToPath(new URL('../../frontend/vite.config.ts', import.meta.url))
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path)
  assert.equal(config.server.proxy['/api'].changeOrigin, false)
})

test('path-mode API binds the workspace slug to current membership and tenant ID', async (t) => {
  const organizationOptions = organizationConfig('https://docuscriptor.pages.dev','docuscriptor.pages.dev','path')
  const f = await fixture(t, { organizationOptions }), person = f.principal(), other = f.principal()
  const headers = { ...person.headers, 'x-organization-slug': f.organizationSlug(person.tenantId) }
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers })).statusCode, 200)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: person.headers })).statusCode, 400)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, 'x-organization-slug': f.organizationSlug(other.tenantId) } })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, 'x-tenant-id': other.tenantId } })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers: { ...headers, 'x-organization-slug': 'evil.invalid' } })).statusCode, 400)
  f.setRole(person, null)
  assert.equal((await f.gateway.inject({ url: '/api/jobs', headers })).statusCode, 403)
  assert.equal((await f.gateway.inject({ url: '/api/organizations', headers: person.headers })).statusCode, 200)
  assert.equal((await f.gateway.inject({ method: 'POST', url: '/api/auth/workspace-session' })).statusCode, 404)
})

test('organization creation requires a valid workspace address', async (t) => {
  const f = await fixture(t), person = f.principal()
  for (const slug of ['app','evil.com','-acme','ab']) {
    const response = await f.gateway.inject({ method: 'POST', url: '/api/organizations', headers: person.headers, payload: { name: 'Requested organization', slug } })
    assert.equal(response.statusCode, 400)
  }
})

test('workspace sign-in is proof-bound, origin-bound, single-use, and keeps credentials out of URLs', async (t) => {
  const f = await fixture(t), person = f.principal(), verifier = randomBytes(32).toString('base64url')
  const response = await link(f, person, verifier)
  assert.equal(response.statusCode, 200, response.body)
  const url = response.json().url
  assert.ok(!url.includes(person.token))
  assert.ok(!url.includes('refresh'))
  assert.equal((await exchange(f, url, randomBytes(32).toString('base64url'))).statusCode, 401)
  assert.equal((await exchange(f, url, verifier, { origin: 'https://evil.invalid' })).statusCode, 401)
  assert.equal((await exchange(f, url, verifier, { host: 'another.docuscriptor.localhost:5173' })).statusCode, 401)
  const result = await exchange(f, url, verifier)
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().access_token, person.token)
  assert.equal(result.json().userId, person.user.id)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal((await exchange(f, url, verifier)).statusCode, 401)
})

test('workspace sign-in and document requests reject mismatched or revoked organization access', async (t) => {
  const f = await fixture(t), person = f.principal(), other = f.principal(), verifier = randomBytes(32).toString('base64url')
  const noAccess = await f.gateway.inject({ method: 'POST', url: '/api/auth/workspace-link', headers: { ...person.headers, origin: config.appOrigin }, payload: {
    organizationId: other.tenantId, refreshToken: 'session', challenge: challenge(verifier), state: randomUUID(),
  } })
  assert.equal(noAccess.statusCode, 403)
  const response = await link(f, person, verifier)
  f.setRole(person, null)
  assert.equal((await exchange(f, response.json().url, verifier)).statusCode, 403)
  const wrongHost = await f.gateway.inject({ url: '/api/jobs', headers: { ...other.headers, host: f.organizationSlug(person.tenantId) + '.docuscriptor.localhost:5173' } })
  assert.equal(wrongHost.statusCode, 403)
})
