import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createBillingProviders } from '../billing/providers.mjs'

const env = {
  STRIPE_BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_example',
  STRIPE_PLUS_PRICE_ID: 'price_plus', STRIPE_ULTIMATE_PRICE_ID: 'price_ultimate',
  RAZORPAY_BILLING_ENABLED: 'true', RAZORPAY_KEY_ID: 'rzp_test_example', RAZORPAY_KEY_SECRET: 'example-key',
  RAZORPAY_WEBHOOK_SECRET: 'example-signing-key', RAZORPAY_PLUS_PLAN_ID: 'plan_plus',
  RAZORPAY_ULTIMATE_PLAN_ID: 'plan_ultimate', RAZORPAY_TOTAL_COUNT: '12',
}
const timestamp = 1800000000
const expires = timestamp + 1800
const checkout = { plan: 'ultimate', tenantId: randomUUID(), attemptId: randomUUID(), returnUrl: 'https://workspace.example/#billing' }
const refs = { tenant_id: checkout.tenantId, attempt_id: checkout.attemptId }
const session = { object: 'checkout.session', id: 'cs_test_123', mode: 'subscription', livemode: false, client_reference_id: checkout.attemptId,
  status: 'open', expires_at: expires, url: 'https://checkout.stripe.com/c/pay/cs_test_123#preview' }
const subscriptionId = 'sub_123'
const itemId = 'si_123', started = timestamp - 3600
const paidLine = { id: 'il_123', object: 'line_item', livemode: false, invoice: 'in_123', amount: 1400, quantity: 1, quantity_decimal: '1',
  period: { start: started, end: expires }, parent: { type: 'subscription_item_details',
    subscription_item_details: { subscription: subscriptionId, subscription_item: itemId, proration: false } },
  pricing: { type: 'price_details', price_details: { price: env.STRIPE_ULTIMATE_PRICE_ID } } }
const paidInvoice = { id: 'in_123', object: 'invoice', livemode: false, status: 'paid', amount_remaining: 0,
  parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
  lines: { has_more: false, data: [paidLine] } }
const stripeSub = { id: subscriptionId, object: 'subscription', livemode: false, status: 'active', metadata: refs,
  items: { has_more: false, data: [{ id: itemId, quantity: 1, price: { id: env.STRIPE_ULTIMATE_PRICE_ID }, current_period_start: started, current_period_end: expires }] },
  latest_invoice: paidInvoice }
const razorSub = { id: subscriptionId, entity: 'subscription', plan_id: env.RAZORPAY_ULTIMATE_PLAN_ID, status: 'created',
  quantity: 1, paid_count: 0, total_count: 12, notes: refs, current_end: expires, expire_by: expires, short_url: 'https://rzp.io/rzp/123' }

function adapters(fetchImpl = () => assert.fail('Unexpected provider request')) {
  return createBillingProviders({ env, fetchImpl, now: () => timestamp * 1000 })
}

function signature(bytes, ts = timestamp) {
  const mac = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(ts + '.').update(bytes).digest('hex')
  return { 'stripe-signature': 't=' + ts + ',v1=' + '0'.repeat(64) + ',v1=' + mac }
}

test('gateways are opt-in and enabled configuration is validated without exposing secrets', () => {
  assert.deepEqual(createBillingProviders({ env: {} }), { stripe: null, razorpay: null })
  assert.deepEqual(createBillingProviders({ env: { STRIPE_BILLING_ENABLED: 'false', STRIPE_SECRET_KEY: 'unconfigured' } }),
    { stripe: null, razorpay: null })
  assert.throws(() => createBillingProviders({ env: { RAZORPAY_BILLING_ENABLED: 'yes' } }), /true or false/)
  assert.throws(() => createBillingProviders({ env: { ...env, RAZORPAY_TOTAL_COUNT: '0' } }), /RAZORPAY_TOTAL_COUNT/)
  assert.throws(() => createBillingProviders({ env: { STRIPE_BILLING_ENABLED: 'true' } }), /STRIPE_SECRET_KEY/)
  assert.throws(() => createBillingProviders({ env: { ...env, STRIPE_ULTIMATE_PRICE_ID: env.STRIPE_PLUS_PRICE_ID } }), /different provider plan/)
})

test('Stripe creates a recurring checkout from server settings, with a stable retry key and subscription binding', async () => {
  const requests = []
  const { stripe } = adapters(async (url, init) => {
    requests.push({ url, ...init })
    return Response.json(session)
  })
  const expected = { checkoutId: session.id, url: session.url, expiresAt: expires }
  assert.deepEqual(await stripe.createCheckout(checkout), expected)
  assert.deepEqual(await stripe.createCheckout(checkout), expected)
  for (const request of requests) {
    assert.equal(request.url, 'https://api.stripe.com/v1/checkout/sessions')
    assert.equal(request.redirect, 'manual')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.Authorization, 'Bearer ' + env.STRIPE_SECRET_KEY)
    assert.equal(request.headers['Idempotency-Key'], checkout.attemptId)
    assert.deepEqual(Object.fromEntries(new URLSearchParams(request.body)), {
      mode: 'subscription', success_url: checkout.returnUrl, cancel_url: checkout.returnUrl,
      'line_items[0][price]': env.STRIPE_ULTIMATE_PRICE_ID, 'line_items[0][quantity]': '1', client_reference_id: checkout.attemptId,
      'subscription_data[metadata][tenant_id]': checkout.tenantId, 'subscription_data[metadata][attempt_id]': checkout.attemptId,
    })
  }
  await assert.rejects(stripe.createCheckout({ ...checkout, plan: 'price_attacker' }), /supported license/)
  assert.equal(requests.length, 2)
  for (const workspace of ['https://org.example/', 'https://workspace.example/org/acme']) {
    const returnUrl = workspace + '?stripe_checkout=success#billing'
    await stripe.createCheckout({ ...checkout, returnUrl })
    const form = new URLSearchParams(requests.at(-1).body)
    assert.equal(form.get('success_url'), returnUrl)
    assert.equal(form.get('cancel_url'), workspace + '?stripe_checkout=cancel#billing')
  }
})

test('Razorpay sends the configured recurring plan and capped duration over authenticated HTTPS', async () => {
  const { razorpay } = adapters(async (url, init) => {
    assert.equal(url, 'https://api.razorpay.com/v1/subscriptions')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64'))
    assert.deepEqual(JSON.parse(init.body), { plan_id: env.RAZORPAY_ULTIMATE_PLAN_ID, total_count: 12, quantity: 1,
      customer_notify: true, expire_by: expires, notes: refs })
    return Response.json(razorSub)
  })
  assert.deepEqual(await razorpay.createCheckout(checkout), { checkoutId: subscriptionId, url: razorSub.short_url, expiresAt: expires })
})

test('providers require exact checkout origins and treat uncertain results as potentially committed', async () => {
  for (const result of [
    { provider: 'stripe', body: { ...session, url: 'https://checkout.stripe.com.bad.example/' } },
    { provider: 'stripe', body: { ...session, livemode: true } },
    { provider: 'stripe', body: { ...session, client_reference_id: randomUUID() } },
    { provider: 'razorpay', body: { ...razorSub, notes: { ...refs, tenant_id: randomUUID() } } },
    { provider: 'razorpay', body: { ...razorSub, short_url: 'https://bad.example@rzp.io/rzp/123' } },
    { provider: 'razorpay', body: { ...razorSub, short_url: 'http://rzp.io/rzp/123' } },
  ]) {
    const gateway = adapters(async () => Response.json(result.body))[result.provider]
    await assert.rejects(gateway.createCheckout(checkout), error => error.statusCode === 502 && !error.checkoutRejected)
  }
  for (const status of [302, 400, 401, 403, 404, 409, 422, 429, 500]) {
    let requests = 0
    const { razorpay } = adapters(async () => {
      requests++
      return new Response('private upstream error', { status })
    })
    await assert.rejects(razorpay.createCheckout(checkout), error => error.statusCode === 502 &&
      !!error.checkoutRejected === [400, 401, 403, 404, 422].includes(status) && !error.message.includes('private'))
    assert.equal(requests, 1)
  }
  for (const run of [() => { throw new Error('connection reset') }, () => new Response('invalid')]) {
    await assert.rejects(adapters(run).razorpay.createCheckout(checkout), error => error.statusCode === 502 && !error.checkoutRejected)
  }
})

test('Stripe verifies the raw bytes, timestamp and live mode before using signed subscription identifiers', () => {
  const { stripe } = adapters()
  for (const [type, object] of [
    ['customer.subscription.updated', { object: 'subscription', id: subscriptionId }],
    ['checkout.session.completed', { object: 'checkout.session', mode: 'subscription', subscription: subscriptionId }],
    ['checkout.session.async_payment_succeeded', { object: 'checkout.session', mode: 'subscription', subscription: subscriptionId }],
    ['checkout.session.async_payment_failed', { object: 'checkout.session', mode: 'subscription', subscription: subscriptionId }],
    ['invoice.paid', { object: 'invoice', parent: { subscription_details: { subscription: subscriptionId } } }],
    ['invoice.payment_failed', { object: 'invoice', subscription: subscriptionId }],
  ]) {
    const event = { object: 'event', livemode: false, id: 'evt_123', type, data: { object } }
    const bytes = Buffer.from(JSON.stringify(event, null, 3))
    assert.deepEqual(stripe.parseWebhook(bytes, signature(bytes)), { eventId: event.id, subscriptionId })
    assert.throws(() => stripe.parseWebhook(Buffer.from(JSON.stringify(event)), signature(bytes)), /verified/)
    assert.throws(() => stripe.parseWebhook(bytes, signature(bytes, timestamp - 301)), /verified/)
    assert.throws(() => stripe.parseWebhook(bytes, signature(bytes, timestamp + 301)), /verified/)
    const live = Buffer.from(JSON.stringify({ ...event, livemode: true }))
    assert.throws(() => stripe.parseWebhook(live, signature(live)), /verified/)
  }
  const ignored = Buffer.from(JSON.stringify({ object: 'event', livemode: false, id: 'evt_123', type: 'product.created' }))
  assert.equal(stripe.parseWebhook(ignored, signature(ignored)), null)
})

test('Razorpay uses the signed entity and a stable replay key across delivery headers', () => {
  const { razorpay } = adapters()
  const bytes = Buffer.from(JSON.stringify({ entity: 'event', event: 'subscription.charged', payload: { subscription: { entity: razorSub } } }))
  const headers = { 'x-razorpay-signature': createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest('hex') }
  const accepted = razorpay.parseWebhook(bytes, { ...headers, 'x-razorpay-event-id': 'first' })
  assert.equal(accepted.subscriptionId, subscriptionId)
  assert.match(accepted.eventId, /^[a-f0-9]{64}$/)
  assert.deepEqual(razorpay.parseWebhook(bytes, { ...headers, 'x-razorpay-event-id': 'replacement' }), accepted)
  assert.throws(() => razorpay.parseWebhook(Buffer.concat([bytes, Buffer.from(' ')]), headers), /verified/)
  assert.throws(() => razorpay.parseWebhook(bytes, { 'x-razorpay-signature': 'ab' }), /verified/)
})

test('canonical Stripe subscription binds the plan, tenant and paid period', async () => {
  let snapshot = stripeSub
  const { stripe } = adapters(async (url, init) => {
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/' + subscriptionId + '?expand%5B%5D=latest_invoice')
    assert.equal(init.redirect, 'manual')
    return Response.json(snapshot)
  })
  assert.deepEqual(await stripe.getSubscription(subscriptionId), { subscriptionId, plan: 'ultimate',
    tenantId: checkout.tenantId, attemptId: checkout.attemptId, status: 'active', periodEnd: expires })
  snapshot = { ...stripeSub, latest_invoice: { status: 'open' } }
  assert.equal((await stripe.getSubscription(subscriptionId)).status, 'pending')
  snapshot = { ...stripeSub, items: { ...stripeSub.items, has_more: true }, metadata: {} }
  assert.equal((await stripe.getSubscription(subscriptionId)).plan, null)
  assert.equal((await stripe.getSubscription(subscriptionId)).tenantId, null)
  snapshot = { ...stripeSub, livemode: true }
  await assert.rejects(stripe.getSubscription(subscriptionId), /provider/)
  await assert.rejects(stripe.getSubscription('../wrong'), /provider/)
})

test('a paid Stripe invoice covers only its subscription item, configured price, quantity and service period', async () => {
  const itemParent = changes => ({ ...paidLine.parent, subscription_item_details: { ...paidLine.parent.subscription_item_details, ...changes } })
  const invoiceFor = line => ({ ...paidInvoice, lines: { has_more: false, data: [line] } })
  for (const invoice of [
    { ...paidInvoice, status: 'open' }, { ...paidInvoice, livemode: true }, { ...paidInvoice, amount_remaining: 500 },
    { ...paidInvoice, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_other' } } },
    ...[
      { parent: itemParent({ subscription_item: 'si_other' }) }, { parent: itemParent({ subscription: 'sub_other' }) },
      { parent: { type: 'invoice_item_details' } }, { pricing: { type: 'price_details', price_details: { price: 'price_unknown' } } },
      { invoice: 'in_other' }, { livemode: true }, { amount: -20 }, { amount: 0, parent: itemParent({ proration_details: { credited_items: {} } }) },
      { quantity: 2 }, { quantity_decimal: '1.01' }, { period: { start: started, end: timestamp - 1 } },
      { period: { start: timestamp + 1, end: expires } }, { period: { start: started - 1800, end: expires } },
    ].map(change => invoiceFor({ ...paidLine, ...change })),
  ]) {
    const { stripe } = adapters(async () => Response.json({ ...stripeSub, latest_invoice: invoice }))
    assert.equal((await stripe.getSubscription(subscriptionId)).status, 'pending')
  }
  const prorated = { ...paidLine, period: { start: timestamp - 30, end: expires }, parent: itemParent({ proration: true }) }
  const { stripe } = adapters(async () => Response.json({ ...stripeSub, latest_invoice: invoiceFor(prorated) }))
  assert.equal((await stripe.getSubscription(subscriptionId)).status, 'active')
})

test('unbilled Stripe plan changes keep the lower covered tier and paid upgrade lines may be paginated', async () => {
  const plusLine = { ...paidLine, id: 'il_plus', pricing: { type: 'price_details', price_details: { price: env.STRIPE_PLUS_PRICE_ID } } }
  let snapshot = { ...stripeSub, latest_invoice: { ...paidInvoice, lines: { has_more: false, data: [plusLine] } } }
  const nextUrl = 'https://api.stripe.com/v1/invoices/in_123/lines?limit=100&starting_after=il_plus'
  let next = { has_more: false, data: [{ ...paidLine, quantity_decimal: '1.000000' }] }, pages = 0
  const { stripe } = adapters(async (url, init) => {
    if (url.includes('/subscriptions/')) return Response.json(snapshot)
    assert.equal(url, nextUrl)
    assert.equal(init.headers.Authorization, 'Bearer ' + env.STRIPE_SECRET_KEY)
    pages++
    return Response.json(next)
  })
  async function expectActive(plan) {
    const result = await stripe.getSubscription(subscriptionId)
    assert.deepEqual([result.status, result.plan, result.periodEnd], ['active', plan, expires])
  }
  await expectActive('plus')
  snapshot = { ...stripeSub, items: { has_more: false, data: [{ ...stripeSub.items.data[0], price: { id: env.STRIPE_PLUS_PRICE_ID } }] } }
  await expectActive('plus')
  assert.equal(pages, 0)
  snapshot = { ...stripeSub, latest_invoice: { ...paidInvoice, lines: { has_more: true, data: [plusLine] } } }
  await expectActive('ultimate')
  assert.equal(pages, 1)
  next = { has_more: true, data: [plusLine] }
  await assert.rejects(stripe.getSubscription(subscriptionId), error => error.statusCode === 502)
})

test('canonical Razorpay subscription withholds access on authentication and maps paused or ended billing', async () => {
  let snapshot = { ...razorSub, status: 'authenticated' }
  const invoice = { entity: 'invoice', status: 'paid', amount_due: 0, subscription_id: subscriptionId,
    billing_start: timestamp - 1200, billing_end: expires }
  let invoices = []
  const { razorpay } = adapters(async (url) => {
    if (url === 'https://api.razorpay.com/v1/invoices?subscription_id=' + subscriptionId) {
      return Response.json({ entity: 'collection', items: invoices })
    }
    assert.equal(url, 'https://api.razorpay.com/v1/subscriptions/' + subscriptionId)
    return Response.json(snapshot)
  })
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'pending')
  snapshot = { ...razorSub, status: 'active' }
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'pending')
  snapshot.paid_count = 1
  invoices = [{ ...invoice, billing_end: timestamp - 1200 }, { ...invoice, subscription_id: 'sub_other' },
    { ...invoice, status: 'issued' }, { ...invoice, billing_start: timestamp + 60 }]
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'pending')
  invoices.push(invoice)
  assert.deepEqual(await razorpay.getSubscription(subscriptionId), { subscriptionId, plan: 'ultimate',
    tenantId: checkout.tenantId, attemptId: checkout.attemptId, status: 'active', periodEnd: expires })
  snapshot.status = 'completed'
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'active')
  snapshot.current_end = timestamp
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'canceled')
  snapshot = { ...snapshot, status: 'paused', plan_id: 'plan_unknown' }
  assert.equal((await razorpay.getSubscription(subscriptionId)).plan, null)
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'past_due')
  snapshot.status = 'cancelled'
  assert.equal((await razorpay.getSubscription(subscriptionId)).status, 'canceled')
  snapshot.id = 'sub_other'
  await assert.rejects(razorpay.getSubscription(subscriptionId), /provider/)
})

test('checkout reconciliation distinguishes open, closed, and subscribed attempts', async () => {
  for (const [provider, original, statuses] of [
    ['stripe', session, [['open', 'open'], ['expired', 'closed'], ['complete', 'subscribed']]],
    ['razorpay', razorSub, [['created', 'open'], ['expired', 'closed'], ['authenticated', 'subscribed']]],
  ]) {
    for (const [status, state] of statuses) {
      const adapter = adapters(async () => Response.json({ ...original, status, subscription: state === 'subscribed' ? subscriptionId : null }))[provider]
      const expected = state === 'subscribed' ? { state, subscriptionId } : { state }
      assert.deepEqual(await adapter.inspectCheckout(original.id), expected)
    }
  }
})

test('a lost Razorpay response can recover only the original payable checkout from an authenticated lookup', async () => {
  let remote = razorSub
  let creations = 0
  const { razorpay } = adapters(async (url, init) => {
    if (init.method === 'POST') {
      creations++
      throw new Error('Connection dropped after provider accepted creation')
    }
    assert.equal(url, 'https://api.razorpay.com/v1/subscriptions/' + subscriptionId)
    assert.match(init.headers.Authorization, /^Basic /)
    return Response.json(remote)
  })
  await assert.rejects(razorpay.createCheckout(checkout), error => !error.checkoutRejected)
  const recovered = await razorpay.getSubscription(subscriptionId)
  assert.deepEqual(recovered, { subscriptionId, tenantId: checkout.tenantId, attemptId: checkout.attemptId,
    plan: 'ultimate', status: 'pending', periodEnd: expires,
    checkout: { checkoutId: subscriptionId, url: razorSub.short_url, expiresAt: expires } })
  for (const change of [
    { expire_by: timestamp }, { expire_by: 8_640_000_000_001 }, { short_url: null }, { paid_count: 1 },
    { quantity: 2 }, { plan_id: 'plan_unknown' }, { notes: { ...refs, tenant_id: 'unknown' } },
    { notes: { ...refs, attempt_id: null } }, { status: 'authenticated' },
  ]) {
    remote = { ...razorSub, ...change }
    assert.equal((await razorpay.getSubscription(subscriptionId)).checkout, undefined)
  }
  remote = { ...razorSub, short_url: 'https://rzp.io.bad.example/rzp/123' }
  await assert.rejects(razorpay.getSubscription(subscriptionId), /provider/)
  remote = { ...razorSub, id: 'sub_other' }
  await assert.rejects(razorpay.getSubscription(subscriptionId), /provider/)
  remote = { ...razorSub, current_end: 8_640_000_000_001 }
  assert.equal((await razorpay.getSubscription(subscriptionId)).periodEnd, null)
  assert.equal(creations, 1)
})
