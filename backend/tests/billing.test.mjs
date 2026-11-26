import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fixture } from './helpers.mjs'
import { recoverBilling } from '../billing/recover.mjs'

const day = 86_400_000
const status = (f, person) => f.gateway.inject({ url: '/api/billing', headers: person.headers })
const post = (f, person, path, payload) => f.gateway.inject({ url: '/api/billing/' + path, method: 'POST', headers: person.headers, payload })
const checkout = (f, person, provider = 'stripe', plan = 'plus') => post(f, person, 'checkout', { provider, plan })

function service() {
  let time = Date.UTC(2027, 0, 1)
  const state = { creates: [], reads: 0, remote: new Map(), inspect: { state: 'open' }, createError: null }
  function adapter(provider) {
    return {
      async createCheckout(input) {
        state.creates.push({ ...input, provider })
        const key = 'sub_' + input.attemptId.replaceAll('-', '')
        state.remote.set(key, { subscriptionId: key, attemptId: input.attemptId, tenantId: input.tenantId, plan: input.plan,
          status: 'pending', periodEnd: null })
        if (state.duringCreate) await state.duringCreate()
        if (state.createError) throw state.createError
        return { checkoutId: provider === 'razorpay' ? key : 'cs_test_' + input.attemptId, url: 'https://test.invalid/checkout', expiresAt: Math.floor((time + day) / 1000) }
      },
      inspectCheckout: async () => state.inspect,
      async getSubscription(id) {
        state.reads++
        if (state.duringRead) await state.duringRead()
        return state.remote.get(id)
      },
      parseWebhook(bytes, headers) {
        assert.ok(Buffer.isBuffer(bytes))
        assert.equal(headers['test-signature'], 'fixture')
        return JSON.parse(bytes)
      },
    }
  }
  return { state, advance(ms) { time += ms }, options: { env: { BILLING_MODE: 'managed' }, now: () => time,
    providers: { stripe: adapter('stripe'), razorpay: adapter('razorpay') } } }
}
const hook = (f, provider, subscriptionId, eventId = randomUUID()) => f.gateway.inject({
  url: '/api/billing/webhooks/' + provider, method: 'POST', headers: { 'test-signature': 'fixture','content-type': 'application/json' },
  payload: JSON.stringify({ subscriptionId, eventId }, null, 2),
})

test('billing is optional and organization owners alone can see or change it', async t => {
  const f = await fixture(t, { billingOptions: { env: {} } })
  const owner = f.principal('owner')
  const result = await status(f, owner)
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json().providers, { stripe: false, razorpay: false })
  assert.equal(result.json().plan, 'self-hosted')
  assert.equal(result.json().canCheckout, false)
  assert.equal((await checkout(f, owner)).statusCode, 503)
  assert.equal((await f.gateway.inject('/api/billing')).statusCode, 401)
  for (const role of ['admin','operator','viewer']) {
    const member = f.principal(role, owner.tenantId)
    assert.equal((await status(f, member)).statusCode, 403)
    assert.equal((await checkout(f, member)).statusCode, 403)
    assert.equal((await post(f, member, 'refresh', {})).statusCode, 403)
  }
  assert.equal((await hook(f, 'stripe','sub_unused')).statusCode, 404)
})

test('one hosted checkout covers concurrent requests; conflicting plans and providers are denied', async t => {
  const { state, options } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner')
  let finish, started
  const ready = new Promise(resolve => { started = resolve })
  state.duringCreate = () => { started(); return new Promise(resolve => { finish = resolve }) }
  const first = checkout(f, owner)
  const result = first.then(r => r)
  await ready
  assert.equal((await checkout(f, owner, 'razorpay')).statusCode, 409)
  const duplicate = checkout(f, owner).then(r => r)
  finish()
  for (const r of await Promise.all([result, duplicate])) {
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().url, 'https://test.invalid/checkout')
  }
  assert.equal(state.creates.length, 1)
  assert.ok(state.creates[0].returnUrl.endsWith('/?stripe_checkout=success#billing'))
  assert.equal((await checkout(f, owner, 'stripe', 'ultimate')).statusCode, 409)
  await f.restart()
  assert.equal((await checkout(f, owner)).statusCode, 200)
  assert.equal(state.creates.length, 1)
  const bill = (await status(f, owner)).json()
  assert.equal(bill.plan, 'starter')
  assert.deepEqual(bill.pending, { provider: 'stripe', plan: 'plus' })
})

test('a change of ownership while the provider is creating checkout withholds the hosted link', async t => {
  const { state, options } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner')
  state.duringCreate = () => f.setRole(owner, 'viewer')
  assert.equal((await checkout(f, owner)).statusCode, 403)
  const nextOwner = f.principal('owner', owner.tenantId)
  assert.equal((await checkout(f, nextOwner)).statusCode, 200)
  assert.equal(state.creates.length, 1)
})

test('Stripe retries reuse the attempt and expired links cannot launch a second subscription without provider confirmation', async t => {
  const { state, options, advance } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner')
  state.createError = new Error('lost creation response')
  assert.equal((await checkout(f, owner)).statusCode, 500)
  await f.restart()
  state.createError = null
  assert.equal((await checkout(f, owner)).statusCode, 200)
  assert.equal(state.creates[1].attemptId, state.creates[0].attemptId)
  advance(day)
  assert.equal((await checkout(f, owner, 'razorpay')).statusCode, 409)
  assert.equal(state.creates.length, 2)
  state.inspect = { state: 'closed' }
  assert.equal((await checkout(f, owner, 'razorpay')).statusCode, 200)
  assert.notEqual(state.creates[2].attemptId, state.creates[0].attemptId)
})

test('licenses follow the scoped authoritative subscription including plan changes, expiry and cancellation', async t => {
  const { state, options, advance } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner'), other = f.principal('owner')
  await checkout(f, owner)
  const [id, remote] = [...state.remote][0]
  const event = randomUUID()
  // Neither a checkout URL nor an authorization-only event grants paid capacity.
  assert.equal((await hook(f, 'stripe', id)).statusCode, 204)
  assert.equal((await status(f, owner)).json().plan, 'starter')
  remote.status = 'active'
  remote.periodEnd = Math.floor((options.now() + day) / 1000)
  assert.equal((await hook(f, 'stripe', id, event)).statusCode, 204)
  assert.equal((await status(f, owner)).json().plan, 'plus')
  await f.restart()
  const before = state.reads
  assert.equal((await hook(f, 'stripe', id, event)).statusCode, 204)
  assert.equal(state.reads, before)
  assert.equal((await status(f, other)).json().subscription, null)
  assert.equal((await checkout(f, owner, 'razorpay')).statusCode, 409)
  assert.equal((await post(f, other, 'refresh', { subscriptionId: id })).statusCode, 409)
  // Editing subscription metadata at the merchant cannot move the license between tenants.
  remote.tenantId = other.tenantId
  remote.attemptId = null
  remote.plan = 'ultimate'
  assert.equal((await post(f, owner, 'refresh', {})).json().plan, 'ultimate')
  assert.equal((await status(f, other)).json().plan, 'starter')
  advance(day)
  const expired = (await status(f, owner)).json()
  assert.equal(expired.plan, 'starter')
  assert.equal(expired.subscription.status, 'expired')
  assert.equal(expired.canCheckout, false)
  remote.status = 'past_due'
  await hook(f, 'stripe', id)
  assert.equal((await status(f, owner)).json().subscription.status, 'past_due')
  remote.status = 'canceled'
  await hook(f, 'stripe', id)
  assert.equal((await status(f, owner)).json().canCheckout, true)
  assert.equal((await checkout(f, owner,'razorpay','ultimate')).statusCode, 200)
  // Even an old delivery arriving after a new checkout cannot reactivate the superseded subscription.
  remote.status = 'active'
  remote.periodEnd += 86400
  await hook(f, 'stripe', id)
  assert.equal((await status(f, owner)).json().plan, 'starter')
})

test('ambiguous Razorpay creation survives restart and is recovered only by the matching provider record', async t => {
  const { state, options } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner')
  state.createError = new Error('test transport failure')
  assert.equal((await checkout(f, owner,'razorpay')).statusCode, 500)
  await f.restart()
  assert.equal((await checkout(f, owner,'razorpay')).statusCode, 409)
  assert.equal(state.creates.length, 1)
  const [id, remote] = [...state.remote][0]
  remote.tenantId = randomUUID()
  assert.equal((await post(f, owner, 'refresh', { subscriptionId: id })).statusCode, 404)
  remote.tenantId = owner.tenantId
  remote.plan = null
  assert.equal((await post(f, owner, 'refresh', { subscriptionId: id })).statusCode, 409)
  remote.plan = 'plus'
  remote.checkout = { checkoutId: id, url: 'https://test.invalid/recovered', expiresAt: Math.floor((options.now() + day) / 1000) }
  assert.deepEqual((await post(f, owner, 'refresh', { subscriptionId: id })).json().pending, { provider: 'razorpay', plan: 'plus' })
  assert.equal((await checkout(f, owner, 'razorpay')).json().url, remote.checkout.url)
  remote.status = 'active'
  remote.periodEnd = Math.floor((options.now() + day) / 1000)
  assert.equal((await post(f, owner, 'refresh', { subscriptionId: id })).json().plan, 'plus')
})

test('the operator recovery tool requires the exact unseen checkout and records its resolution', async t => {
  const { state, options } = service()
  const f = await fixture(t, { billingOptions: options })
  const owner = f.principal('owner')
  state.createError = new Error('unknown outcome')
  await checkout(f, owner, 'razorpay')
  const env = { DATA_PATH: join(f.dir, 'workspace.sqlite') }
  const base = ['--tenant',owner.tenantId,'--provider','razorpay']
  const { attempt } = recoverBilling(['show',...base], env)
  const release = ['release',...base,'--attempt',attempt,'--reason','Merchant verified no remote subscription']
  assert.throws(() => recoverBilling(release, env), /confirmed-absent/)
  assert.equal(recoverBilling([...release,'--confirmed-absent'], env).released, attempt)
  assert.throws(() => recoverBilling([...release,'--confirmed-absent'], env), /no unconfirmed/)
  const db = new DatabaseSync(env.DATA_PATH + '.billing.sqlite', { readOnly: true })
  try { assert.equal(db.prepare('SELECT reason FROM billing_recoveries WHERE attempt_id=?').get(attempt).reason, 'Merchant verified no remote subscription') }
  finally { db.close() }
  state.createError = null
  assert.equal((await checkout(f, owner, 'razorpay')).statusCode, 200)
})
