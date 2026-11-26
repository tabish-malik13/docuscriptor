import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import test from 'node:test'
import { createBillingProviders } from '../billing/providers.mjs'
import { fixture } from './helpers.mjs'

test('Stripe hosted checkout, return reconciliation and signed asynchronous payment grant one durable tenant license', async t => {
  const issued = 1800000000, ends = issued + 30 * 86400, now = () => issued * 1000
  const env = { BILLING_MODE: 'managed', STRIPE_BILLING_ENABLED: 'true', STRIPE_PLUS_PRICE_ID: 'price_Plus',
    STRIPE_ULTIMATE_PRICE_ID: 'price_Ultimate', STRIPE_SECRET_KEY: 'sk_test_' + randomBytes(32).toString('hex'),
    STRIPE_WEBHOOK_SECRET: 'whsec_' + randomBytes(32).toString('hex') }
  const session = { id: 'cs_test_local', object: 'checkout.session', mode: 'subscription', status: 'open', livemode: false,
    expires_at: issued + 1800, url: 'https://checkout.stripe.com/c/pay/cs_test_local', subscription: null }
  const subscription = { id: 'sub_local', object: 'subscription', livemode: false, status: 'active', metadata: {},
    items: { has_more: false, data: [{ id: 'si_local', quantity: 1, price: { id: env.STRIPE_PLUS_PRICE_ID },
      current_period_start: issued, current_period_end: ends }] },
    latest_invoice: { id: 'in_local', object: 'invoice', livemode: false, status: 'open', amount_remaining: 1200,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_local' } },
      lines: { has_more: false, data: [{ id: 'il_local', invoice: 'in_local', object: 'line_item', livemode: false,
        amount: 1200, quantity: 1, period: { start: issued, end: ends },
        parent: { type: 'subscription_item_details', subscription_item_details: { subscription_item: 'si_local', subscription: 'sub_local' } },
        pricing: { type: 'price_details', price_details: { price: env.STRIPE_PLUS_PRICE_ID } } }] } } }
  let checkoutBody, subscriptionReads = 0, providerUnavailable = false
  const fetchImpl = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.stripe.com')
    assert.equal(init.headers.Authorization, 'Bearer ' + env.STRIPE_SECRET_KEY)
    switch (new URL(url).pathname) {
      case '/v1/checkout/sessions':
        assert.equal(init.method, 'POST')
        checkoutBody = new URLSearchParams(init.body)
        session.client_reference_id = checkoutBody.get('client_reference_id')
        assert.equal(init.headers['Idempotency-Key'], session.client_reference_id)
        subscription.metadata = { attempt_id: checkoutBody.get('subscription_data[metadata][attempt_id]'),
          tenant_id: checkoutBody.get('subscription_data[metadata][tenant_id]') }
        return Response.json(session)
      case '/v1/checkout/sessions/' + session.id:
        return Response.json(session)
      case '/v1/subscriptions/' + subscription.id:
        assert.equal(new URL(url).searchParams.get('expand[]'), 'latest_invoice')
        subscriptionReads++
        return providerUnavailable ? new Response(null, { status: 503 }) : Response.json(subscription)
      default: throw new Error('Unexpected Stripe test request')
    }
  }
  const appOrigin = 'https://workspace.example'
  const f = await fixture(t, { billingOptions: { env, providers: createBillingProviders({ env, now, fetchImpl }), now },
    organizationOptions: { appOrigin, baseDomain: 'workspace.example', routing: 'path' } })
  const owner = f.principal('owner'), other = f.principal('owner')
  const request = (actor, route = '', payload) => f.gateway.inject({ method: payload ? 'POST' : 'GET', url: '/api/billing' + route,
    headers: { ...actor.headers, 'x-organization-slug': f.organizationSlug(actor.tenantId) }, payload })
  const describe = async actor => {
    const result = await request(actor)
    assert.equal(result.statusCode, 200)
    return result.json()
  }
  assert.deepEqual((await describe(owner)).providers, { stripe: true, razorpay: false })
  assert.equal((await request(owner, '/checkout', { provider: 'razorpay', plan: 'plus' })).statusCode, 503)
  const checkout = await request(owner, '/checkout', { provider: 'stripe', plan: 'plus' })
  assert.equal(checkout.statusCode, 200)
  assert.deepEqual(checkout.json(), { url: session.url })
  const workspace = appOrigin + '/org/' + f.organizationSlug(owner.tenantId)
  assert.equal(checkoutBody.get('success_url'), workspace + '?stripe_checkout=success#billing')
  assert.equal(checkoutBody.get('cancel_url'), workspace + '?stripe_checkout=cancel#billing')
  assert.equal(checkoutBody.get('line_items[0][price]'), env.STRIPE_PLUS_PRICE_ID)
  assert.equal(subscription.metadata.tenant_id, owner.tenantId)
  assert.deepEqual((await describe(owner)).pending, { provider: 'stripe', plan: 'plus' })

  session.status = 'complete'
  session.subscription = subscription.id
  subscription.metadata.tenant_id = other.tenantId
  assert.equal((await request(owner, '/refresh', {})).statusCode, 404)
  assert.equal((await describe(other)).subscription, null)
  subscription.metadata.tenant_id = owner.tenantId
  const reconciled = await request(owner, '/refresh', {})
  assert.equal(reconciled.statusCode, 200)
  assert.equal(reconciled.json().subscription.status, 'pending')
  assert.equal(reconciled.json().plan, 'starter')

  const bytes = Buffer.from(JSON.stringify({ id: 'evt_delayed', object: 'event', livemode: false,
    type: 'checkout.session.async_payment_succeeded', data: { object: session } }, null, 2))
  const hmac = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(issued + '.').update(bytes).digest('hex')
  const deliver = mac => f.gateway.inject({ method: 'POST', url: '/api/billing/webhooks/stripe', payload: bytes,
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=' + issued + ',v1=' + mac } })
  subscription.latest_invoice.status = 'paid'
  subscription.latest_invoice.amount_remaining = 0
  const before = subscriptionReads
  assert.equal((await deliver('0'.repeat(64))).statusCode, 400)
  assert.equal(subscriptionReads, before)
  providerUnavailable = true
  assert.equal((await deliver(hmac)).statusCode, 502)
  assert.equal((await describe(owner)).plan, 'starter')
  providerUnavailable = false
  assert.equal((await deliver(hmac)).statusCode, 204)
  await f.restart()
  const after = subscriptionReads
  assert.equal((await deliver(hmac)).statusCode, 204)
  assert.equal(subscriptionReads, after)
  const confirmed = await describe(owner)
  assert.equal(confirmed.plan, 'plus')
  assert.equal(confirmed.source, 'subscription')
  assert.equal(confirmed.subscription.periodEnd, new Date(ends * 1000).toISOString())
  assert.equal((await request(other, '/refresh', { subscriptionId: subscription.id })).statusCode, 409)
  assert.equal((await describe(other)).plan, 'starter')
})
