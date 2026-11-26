import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gatewayFeatures } from '../gateway/features.mjs'
import { openBillingStore } from '../billing/store.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { fixture, invoiceValues } from './helpers.mjs'

const inject = (f, method, url, headers, payload) => f.gateway.inject({ method, url, headers, payload })
const oauth = (f, client, scope) => inject(f, 'POST', '/api/oauth/token', {
  authorization: 'Basic ' + Buffer.from(client.id + ':' + client.clientSecret).toString('base64'),
  'content-type': 'application/x-www-form-urlencoded',
}, new URLSearchParams({ grant_type: 'client_credentials', ...(scope && { scope }) }).toString())
const upload = async () => ({ name: 'Review', filename: 'review.docx', file: (await starterTemplate('invoice')).toString('base64') })
const generation = { templateId: 'invoice', values: invoiceValues() }

test('feature discovery reports only effective public settings and validates every configured switch', async t => {
  const expected = { auth: true, apiClients: true, whatsapp: true, billing: true, batches: true, templateApiEdits: true,
    livePreview: true, templateDeletion: true, templateVersions: true, orgCreation: true, rateLimits: true }
  assert.deepEqual(gatewayFeatures({}), expected)
  for (const value of ['yes', 'False', '0', '']) {
    assert.throws(() => gatewayFeatures({ FEATURE_API_CLIENTS: 'false', FEATURE_WHATSAPP: value }), /FEATURE_WHATSAPP/)
  }
  const f = await fixture(t, { featureEnv: { FEATURE_API_CLIENTS: 'false', FEATURE_AUTH: 'false', FEATURE_BILLING: 'false' },
    billingOptions: { env: { BILLING_MODE: 'managed', STRIPE_BILLING_ENABLED: 'invalid' } }, whatsappOptions: { configPath: '/unavailable' } })
  const result = await f.gateway.inject('/api/features')
  assert.equal(result.statusCode, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(result.json(), { ...expected, auth: false, apiClients: false, whatsapp: false, billing: false,
    orgCreation: false, templateApiEdits: false })
  for (const url of ['/api/integrations/whatsapp/webhook','/api/tenant/whatsapp','/api/billing','/api/auth/session','/api/organizations']) {
    assert.equal((await f.gateway.inject(url)).statusCode, 404, url)
  }
  for (const url of ['/api/billing/webhooks/stripe','/api/billing/checkout','/api/auth/workspace-session','/api/auth/workspace-link','/api/tenant/clients']) {
    assert.equal((await inject(f, 'POST', url, {}, {})).statusCode, 404, url)
  }
})

test('auth and API client switches independently apply to requests and credentials from before restart', async t => {
  const featureEnv = {}, f = await fixture(t, { featureEnv }), owner = f.principal('owner')
  const create = await inject(f, 'POST', '/api/tenant/clients', owner.headers, { name: 'Automation', scopes: ['documents:generate'] })
  assert.equal(create.statusCode, 201)
  const client = create.json(), token = (await oauth(f, client)).json().access_token
  const machine = { authorization: 'Bearer ' + token }
  const generate = headers => inject(f, 'POST', '/api/docx/generate', headers, generation)
  featureEnv.FEATURE_AUTH = 'false'
  await f.restart()
  const authCalls = f.authCalls
  assert.equal((await generate(owner.headers)).statusCode, 403)
  assert.equal((await generate({})).statusCode, 403)
  assert.equal((await generate(machine)).statusCode, 200)
  assert.equal((await oauth(f, client)).statusCode, 200)
  assert.equal(f.authCalls, authCalls)
  featureEnv.FEATURE_API_CLIENTS = 'false'
  featureEnv.FEATURE_AUTH = 'true'
  await f.restart()
  assert.equal((await generate(machine)).statusCode, 403)
  assert.equal((await generate(owner.headers)).statusCode, 200)
  assert.equal((await oauth(f, client)).statusCode, 404)
  assert.equal((await f.gateway.inject({ url: '/api/tenant/clients', headers: owner.headers })).statusCode, 404)
})

test('disabled machine template editing preserves human editor saves, content reads and client uploads', async t => {
  const featureEnv = {}, f = await fixture(t, { featureEnv }), owner = f.principal('owner')
  const scope = 'templates:edit:organization', scopes = [scope, 'templates:write', 'templates:read']
  const provision = () => inject(f, 'POST', '/api/tenant/clients', owner.headers, { name: 'Template tools', scopes })
  const client = (await provision()).json(), token = (await oauth(f, client)).json().access_token
  const machine = { authorization: 'Bearer ' + token }, body = await upload()
  const save = async headers => (await inject(f, 'POST', '/api/templates', headers, body)).json().id
  const personal = '/api/templates/' + await save(owner.headers), own = '/api/templates/' + await save(machine)
  featureEnv.FEATURE_TEMPLATE_API_EDITS = 'false'
  await f.restart()
  assert.equal((await provision()).statusCode, 400)
  assert.equal((await oauth(f, client, scope)).json().error, 'invalid_scope')
  assert.equal((await oauth(f, client)).json().scope, 'templates:write templates:read')
  assert.equal((await inject(f, 'GET', personal, machine)).statusCode, 200)
  const replacement = { baseVersion: 1, filename: body.filename, file: body.file }
  assert.equal((await inject(f, 'PATCH', own, machine, replacement)).statusCode, 404)
  assert.equal((await inject(f, 'POST', personal + '/versions', machine, replacement)).statusCode, 403)
  assert.equal((await inject(f, 'POST', personal + '/versions', owner.headers, replacement)).statusCode, 201)
  assert.equal((await inject(f, 'POST', own + '/versions', machine, replacement)).statusCode, 403)
  assert.equal((await inject(f, 'POST', '/api/templates', machine, body)).statusCode, 201)
})

test('optional document routes and organization creation close independently of base processing workflows', async t => {
  const featureEnv = {}, f = await fixture(t, { featureEnv }), owner = f.principal('owner')
  const original = await upload()
  const { id } = (await inject(f, 'POST', '/api/templates', owner.headers, original)).json()
  const url = '/api/templates/' + id
  const replacement = { baseVersion: 1, filename: 'letter.docx', file: (await starterTemplate('letter')).toString('base64') }
  assert.equal((await inject(f, 'POST', url + '/versions', owner.headers, replacement)).statusCode, 201)
  Object.assign(featureEnv, { FEATURE_TEMPLATE_VERSIONS: 'false', FEATURE_BATCHES: 'false', FEATURE_ORG_CREATION: 'false',
    FEATURE_TEMPLATE_DELETION: 'false', FEATURE_LIVE_PREVIEW: 'false' })
  await f.restart()
  assert.equal((await f.gateway.inject('/api/features')).json().templateApiEdits, false)
  const denied = [['GET','/api/batches'], ['POST','/api/batches'], ['POST','/api/docx/preview'], ['POST','/api/organizations'],
    ['DELETE',url], ['PATCH',url], ['POST',url+'/versions'], ['GET',url+'/versions'], ['GET',url+'/versions/1/download']]
  for (const [method, path] of denied) {
    assert.equal((await inject(f, method, path, owner.headers)).statusCode, 404, method + ' ' + path)
  }
  assert.equal((await inject(f, 'GET', '/api/organizations', owner.headers)).statusCode, 200)
  assert.equal((await inject(f, 'GET', url + '/download', owner.headers)).statusCode, 200)
  const pinned = await inject(f, 'POST', '/api/docx/generate', owner.headers, { savedTemplateId: id, savedTemplateVersion: 1, values: invoiceValues() })
  assert.equal(pinned.statusCode, 200, pinned.body.slice(0, 100))
})

test('disabling billing keeps the recorded paid tier and manual contract quotas until expiry', async t => {
  const featureEnv = {}, env = { BILLING_MODE: 'managed' }
  let now = Date.now()
  const f = await fixture(t, { featureEnv, billingOptions: { env, now: () => now } })
  const subscriber = f.principal('owner'), contract = f.principal('owner'), unlicensed = f.principal('owner')
  const end = Math.floor(now / 1000) + 30, expiresAt = new Date(end * 1000).toISOString()
  env.BILLING_LICENSES_FILE = join(f.dir, 'licenses.json')
  await writeFile(env.BILLING_LICENSES_FILE, JSON.stringify({ plans: { plus: { savedTemplates: 1 } },
    licenses: { [contract.tenantId]: { plan: 'plus', expiresAt } } }))
  const db = openBillingStore(join(f.dir, 'workspace.sqlite.billing.sqlite'))
  try {
    const attempt = db.start(subscriber.tenantId, 'stripe', 'plus', 'https://example.invalid', now)
    db.sync('stripe', { subscriptionId: 'sub_existing', tenantId: subscriber.tenantId, attemptId: attempt.id,
      plan: 'plus', status: 'active', periodEnd: end }, randomUUID(), now)
  } finally { db.close() }
  featureEnv.FEATURE_BILLING = 'false'
  env.STRIPE_BILLING_ENABLED = 'true' // Disabled payment features must ignore incomplete merchant settings.
  await f.restart()
  const body = await upload()
  const save = person => inject(f, 'POST', '/api/templates', person.headers, body)
  for (const person of [subscriber, contract, unlicensed]) assert.equal((await save(person)).statusCode, 201)
  assert.equal((await save(subscriber)).statusCode, 409)
  assert.equal((await save(contract)).statusCode, 409)
  assert.equal((await save(unlicensed)).statusCode, 201)
  now = end * 1000
  assert.equal((await save(subscriber)).statusCode, 201)
  assert.equal((await save(contract)).statusCode, 201)
})
