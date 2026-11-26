import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLicenseCatalog } from '../billing/catalog.mjs'
import { createStore, defaultWorkspaceLimits } from '../gateway/store.mjs'
import { maxOutputBytes } from '../shared/document-http.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { fixture } from './helpers.mjs'

function catalogFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'docuscripter-license-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'license.json')
  return config => {
    writeFileSync(path, JSON.stringify(config))
    return createLicenseCatalog({ BILLING_LICENSES_FILE: path })
  }
}

test('catalog preserves existing workspace allowances and scopes expiring contracts to their organization', t => {
  const read = catalogFile(t), org = randomUUID(), contract = randomUUID()
  const expiry = '2027-06-01T00:00:00Z'
  const catalog = read({ plans: { plus: { savedTemplates: 275 } }, licenses: {
    [org.toUpperCase()]: { plan: 'plus', expiresAt: expiry }, [contract]: { plan: 'ultimate' },
  } })
  assert.deepEqual(catalog.limits('self-hosted'), defaultWorkspaceLimits)
  assert.deepEqual(catalog.limits('starter'), defaultWorkspaceLimits)
  assert.deepEqual(catalog.limits('plus'), { storageBytes: 1024 ** 3, savedTemplates: 275, retainedJobs: 5000 })
  assert.equal(catalog.manualPlan(org, Date.parse(expiry) - 1), 'plus')
  assert.equal(catalog.manualPlan(org, Date.parse(expiry)), null)
  assert.equal(catalog.manualPlan(contract, Date.parse(expiry)), 'ultimate')
  assert.equal(catalog.manualPlan(randomUUID()), null)
})

test('invalid contract dates, organization IDs and plan limits fail at startup', t => {
  const read = catalogFile(t)
  const org = randomUUID()
  for (const config of [
    { licenses: { [org]: { plan: 'ultimate', expiresAt: '2027-02-30T00:00:00Z' } } },
    { licenses: { [org]: { plan: 'plus', expiresAt: null } } },
    { licenses: { 'organization-name': { plan: 'plus' } } },
    { licenses: { [org]: { plan: 'unlimited' } } },
    { plans: { plus: { savedTemplates: 0 } } }, { plans: { plus: { storageBytes: 2.5 } } },
    { plans: { ultimate: { seats: 500 } } }, { plans: { plus: null } }, { licenses: null },
  ]) assert.throws(() => read(config))
})

test('workspace writes enforce a changing organization license while keeping existing files readable and removable', t => {
  const read = catalogFile(t), org = randomUUID(), other = randomUUID(), author = randomUUID()
  const catalog = read({ plans: {
    plus: { storageBytes: maxOutputBytes + 9, savedTemplates: 1, retainedJobs: 1 },
    ultimate: { storageBytes: maxOutputBytes * 2, savedTemplates: 2, retainedJobs: 2 },
  } })
  const licenses = new Map([[org, 'ultimate'], [other, 'plus']])
  const store = createStore(':memory:', { limitsForTenant: id => catalog.limits(licenses.get(id)) })
  t.after(() => store.close())
  const save = (id, name) => store.saveTemplate(id, name, [], Buffer.alloc(4), author)
  const job = id => store.beginJob(id, { name: 'Contract', kind: 'DOCX', source: 'template', createdBy: author })
  const original = save(org, 'Contract'), unused = save(org, 'Letter')
  const otherTemplate = save(other, 'Invoice')
  assert.throws(() => save(other, 'Letter'), /template limit/)
  const firstJob = job(org)
  store.completeJob(org, firstJob, Buffer.alloc(2))
  store.reviseTemplate(org, original.id, 1, [], Buffer.alloc(3), author)
  assert.deepEqual({ ...store.billingUsage(org) }, { storageBytes: 13, savedTemplates: 2, retainedJobs: 1 })
  licenses.set(org, 'plus')
  assert.equal(store.template(org, original.id, null, 1).file.length, 4)
  assert.equal(store.artifact(org, firstJob).artifact.length, 2)
  assert.throws(() => job(org), /history limit/)
  assert.throws(() => save(org, 'Invoice'), /template limit/)
  assert.ok(store.deleteJob(org, firstJob))
  assert.throws(() => job(org), /storage limit/)
  assert.ok(store.deleteTemplate(org, unused.id))
  const secondJob = job(org)
  assert.equal(store.billingUsage(org).storageBytes, maxOutputBytes + 7)
  store.completeJob(org, secondJob, Buffer.alloc(1))
  assert.equal(store.billingUsage(org).storageBytes, 8)
  assert.equal(store.template(other, otherTemplate.id).file.length, 4)
  assert.deepEqual({ ...store.billingUsage(other) }, { storageBytes: 4, savedTemplates: 1, retainedJobs: 0 })
})

test('a contract applies to the real gateway upload and checkout routes for that tenant through its expiry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'docuscripter-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const org = randomUUID(), path = join(directory, 'licenses.json'), expiresAt = '2027-06-01T00:00:00Z'
  writeFileSync(path, JSON.stringify({ plans: { plus: { savedTemplates: 1 } }, licenses: { [org]: { plan: 'plus', expiresAt } } }))
  let time = Date.parse(expiresAt) - 1000
  const billingOptions = { env: { BILLING_MODE: 'managed', BILLING_LICENSES_FILE: path }, now: () => time,
    providers: { stripe: { createCheckout() { assert.fail('A contract owner should never reach the payment provider.') } } } }
  const f = await fixture(t, { billingOptions })
  const owner = f.principal('owner', org), other = f.principal('owner')
  const status = async person => (await f.gateway.inject({ url: '/api/billing', headers: person.headers })).json()
  const file = (await starterTemplate('letter')).toString('base64')
  const upload = person => f.gateway.inject({ url: '/api/templates', method: 'POST', headers: person.headers,
    payload: { name: 'Letter', filename: 'letter.docx', file } })
  const effective = await status(owner)
  assert.equal(effective.plan, 'plus')
  assert.equal(effective.source, 'contract')
  assert.equal(effective.canCheckout, false)
  const purchase = await f.gateway.inject({ url: '/api/billing/checkout', method: 'POST', headers: owner.headers,
    payload: { plan: 'ultimate', provider: 'stripe' } })
  assert.equal(purchase.statusCode, 409)
  assert.equal((await upload(owner)).statusCode, 201)
  assert.equal((await upload(owner)).statusCode, 409)
  assert.equal((await status(owner)).usage.savedTemplates, 1)
  assert.equal((await status(other)).usage.savedTemplates, 0)
  assert.equal((await status(other)).plan, 'starter')
  time = Date.parse(expiresAt)
  assert.equal((await status(owner)).plan, 'starter')
  assert.equal((await status(owner)).canCheckout, true)
  assert.equal((await upload(owner)).statusCode, 201)
})
