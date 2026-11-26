import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { problem } from '../gateway/store.mjs'
import { uuidPattern } from '../gateway/tenant-authority.mjs'
import { readArtifact } from '../shared/document-http.mjs'

// Only server-owned provider URLs, prices and subscription quantities reach these adapters.
const subscriptionIdPattern = /^sub_[A-Za-z0-9]{1,240}$/
const stripeSessionPattern = /^cs_(?:test|live)_[A-Za-z0-9]{1,235}$/
const stripeVersion = '2026-11-18.endive'
const stripeCheckoutEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'])
const stripeSubscriptionEvents = new Set(['customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed'])
const razorpaySubscriptionEvents = new Set(['subscription.authenticated', 'subscription.activated', 'subscription.charged',
  'subscription.completed', 'subscription.updated', 'subscription.pending', 'subscription.halted',
  'subscription.paused', 'subscription.resumed', 'subscription.cancelled'])

function enabled(env, name) {
  const value = env[name]
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error(name + ' must be true or false.')
}

function setting(env, name, pattern = /^[^\s\x00-\x1f\x7f]{1,512}$/) {
  if (typeof env[name] !== 'string' || !pattern.test(env[name])) throw new Error('Configure a valid ' + name + '.')
  return env[name]
}

function planMap(plus, ultimate) {
  if (plus === ultimate) throw new Error('Configure a different provider plan ID for each license.')
  return { plus, ultimate }
}

function planFor(plans, id) {
  return Object.keys(plans).find(key => plans[key] === id) ?? null
}

function planId(plans, plan) {
  if (!Object.hasOwn(plans, plan)) throw problem(400, 'Choose a supported license.')
  return plans[plan]
}

function providerFailure() {
  return problem(502, 'The billing provider could not complete the request.')
}

async function providerJson(fetchImpl, url, init) {
  let response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(12_000) })
    if (response.ok) return JSON.parse((await readArtifact(response)).toString('utf8'))
    await response.body?.cancel()
  } catch { throw providerFailure() }
  const error = providerFailure()
  // A timeout, duplicate request conflict, 5xx or malformed 2xx may hide a committed creation.
  if ([400, 401, 403, 404, 422].includes(response.status)) error.checkoutRejected = true
  throw error
}

function hostedUrl(raw, allowedOrigins) {
  let url
  try { url = new URL(raw) } catch { throw providerFailure() }
  if (!allowedOrigins.includes(url.origin) || url.username || url.password) throw providerFailure()
  return url.href
}

function unixSeconds(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000 ? value : null
}

function objectId(value) {
  return typeof value === 'string' ? value : value?.id
}

function checkedId(id, pattern = subscriptionIdPattern) {
  if (!pattern.test(typeof id === 'string' ? id : '')) throw providerFailure()
  return id
}

function association(metadata) {
  return {
    tenantId: typeof metadata?.tenant_id === 'string' && uuidPattern.test(metadata.tenant_id) ? metadata.tenant_id : null,
    attemptId: typeof metadata?.attempt_id === 'string' && uuidPattern.test(metadata.attempt_id) ? metadata.attempt_id : null,
  }
}

function signedWebhookError() {
  return problem(400, 'The billing webhook could not be verified.')
}

function matchesMac(hex, mac) {
  return typeof hex === 'string' && /^[a-f\d]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, 'hex'), mac)
}

function eventJson(bytes) {
  try {
    const event = JSON.parse(bytes.toString('utf8'))
    if (event && typeof event === 'object' && !Array.isArray(event)) return event
  } catch { /* malformed provider notification */ }
  throw signedWebhookError()
}

function stripeProvider(env, fetchImpl, now) {
  const key = setting(env, 'STRIPE_SECRET_KEY', /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{1,480}$/)
  const live = key.includes('_live_')
  const signingKey = setting(env, 'STRIPE_WEBHOOK_SECRET', /^whsec_[^\s\x00-\x1f\x7f]{1,480}$/)
  const priceId = /^price_[A-Za-z0-9]{1,240}$/
  const prices = planMap(setting(env, 'STRIPE_PLUS_PRICE_ID', priceId), setting(env, 'STRIPE_ULTIMATE_PRICE_ID', priceId))
  const headers = { Authorization: 'Bearer ' + key, 'Stripe-Version': stripeVersion }
  const api = 'https://api.stripe.com/v1'
  function oneUnit(item) {
    return item?.quantity === 1 && (item.quantity_decimal == null || /^1(?:\.0+)?$/.test(item.quantity_decimal))
  }
  async function paidPlanForInvoice(invoice, subscriptionId, item, currentPlan) {
    const currentTime = Math.floor(now() / 1000)
    const periodStart = unixSeconds(item.current_period_start), periodEnd = unixSeconds(item.current_period_end)
    if (!periodStart || periodStart > currentTime || !periodEnd || periodEnd <= currentTime ||
      !item.id || invoice?.object !== 'invoice' || invoice.livemode !== live || invoice.status !== 'paid' ||
      invoice.amount_remaining !== 0 || invoice.parent?.type !== 'subscription_details' ||
      objectId(invoice.parent.subscription_details?.subscription) !== subscriptionId) return null

    let page = invoice.lines, priorPlan = null
    const seen = new Set()
    for (;;) {
      if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean') throw providerFailure()
      for (const line of page.data) {
        const details = line?.parent?.subscription_item_details
        const start = unixSeconds(line?.period?.start)
        if (line?.object !== 'line_item' || line.livemode !== live || line.parent?.type !== 'subscription_item_details' ||
          objectId(details?.subscription_item) !== item.id || (details.subscription != null && objectId(details.subscription) !== subscriptionId) ||
          (line.invoice != null && objectId(line.invoice) !== invoice.id) || !Number.isSafeInteger(line.amount) || line.amount < 0 ||
          details.proration_details?.credited_items || !oneUnit(line) ||
          !start || start < periodStart || start > currentTime || line.period.end !== periodEnd || line.pricing?.type !== 'price_details') continue
        const paidPlan = planFor(prices, objectId(line.pricing.price_details?.price))
        if (paidPlan === currentPlan) return currentPlan
        // A paid Plus line covers Plus during a pending upgrade. A paid Ultimate line also covers a requested downgrade to Plus.
        if (paidPlan) priorPlan = 'plus'
      }
      if (!page.has_more) return priorPlan
      const cursor = page.data.at(-1)?.id
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw providerFailure()
      seen.add(cursor)
      const id = checkedId(invoice.id, /^in_[A-Za-z0-9]{1,240}$/)
      page = await providerJson(fetchImpl, api + '/invoices/' + id + '/lines?' + new URLSearchParams({ limit: '100', starting_after: cursor }), { headers })
    }
  }
  function checkSession(session, expectedId) {
    checkedId(session?.id, stripeSessionPattern)
    if (session.object !== 'checkout.session' || session.livemode !== live || !session.id.startsWith(live ? 'cs_live_' : 'cs_test_') || session.mode !== 'subscription' ||
      (expectedId && expectedId !== session.id)) throw providerFailure()
  }
  return {
    async createCheckout({ tenantId, plan, attemptId, returnUrl }) {
      const cancelUrl = new URL(returnUrl)
      // Persisted pre-upgrade attempts must replay Stripe's exact original parameters.
      if (cancelUrl.searchParams.get('stripe_checkout') === 'success') cancelUrl.searchParams.set('stripe_checkout', 'cancel')
      const body = new URLSearchParams({
        mode: 'subscription', success_url: returnUrl, cancel_url: cancelUrl.href,
        'line_items[0][price]': planId(prices, plan), 'line_items[0][quantity]': '1', client_reference_id: attemptId,
        'subscription_data[metadata][tenant_id]': tenantId, 'subscription_data[metadata][attempt_id]': attemptId,
      })
      const session = await providerJson(fetchImpl, api + '/checkout/sessions', { method: 'POST', body: body.toString(),
        headers: { ...headers, 'Idempotency-Key': attemptId, 'Content-Type': 'application/x-www-form-urlencoded' } })
      checkSession(session)
      if (session.client_reference_id !== attemptId || session.status !== 'open' || !unixSeconds(session.expires_at)) throw providerFailure()
      return { checkoutId: session.id, url: hostedUrl(session.url, ['https://checkout.stripe.com']), expiresAt: session.expires_at }
    },
    async inspectCheckout(checkoutId) {
      checkedId(checkoutId, stripeSessionPattern)
      const session = await providerJson(fetchImpl, api + '/checkout/sessions/' + checkoutId, { headers })
      checkSession(session, checkoutId)
      if (session.status === 'open') return { state: 'open' }
      if (session.status === 'expired' && !session.subscription) return { state: 'closed' }
      if (session.status === 'complete') return { state: 'subscribed', subscriptionId: checkedId(objectId(session.subscription)) }
      throw providerFailure()
    },
    parseWebhook(bytes, requestHeaders) {
      const signature = requestHeaders['stripe-signature']
      if (!Buffer.isBuffer(bytes) || typeof signature !== 'string') throw signedWebhookError()
      const parts = signature.split(',').map(part => part.trim())
      const timestamps = parts.filter(part => part.startsWith('t=')).map(part => part.slice(2))
      if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0]) ||
        Math.abs(Math.floor(now() / 1000) - Number(timestamps[0])) > 300) throw signedWebhookError()
      const mac = createHmac('sha256', signingKey).update(timestamps[0] + '.').update(bytes).digest()
      if (!parts.some(part => part.startsWith('v1=') && matchesMac(part.slice(3), mac))) throw signedWebhookError()
      const event = eventJson(bytes)
      if (event.livemode !== live || !/^evt_[A-Za-z0-9]{1,240}$/.test(event.id) || event.object !== 'event') throw signedWebhookError()
      const entity = event.data?.object
      let id
      if (stripeSubscriptionEvents.has(event.type) && entity?.object === 'subscription') id = entity.id
      else if (stripeCheckoutEvents.has(event.type) && entity?.object === 'checkout.session' && entity.mode === 'subscription') id = objectId(entity.subscription)
      else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type) && entity?.object === 'invoice') {
        // Webhook endpoints can be configured for older API versions.
        id = objectId(entity.parent?.subscription_details?.subscription ?? entity.subscription)
      }
      if (!id) return null
      if (typeof id !== 'string' || !subscriptionIdPattern.test(id)) throw signedWebhookError()
      return { eventId: event.id, subscriptionId: id }
    },
    async getSubscription(id) {
      checkedId(id)
      const sub = await providerJson(fetchImpl, api + '/subscriptions/' + id + '?expand%5B%5D=latest_invoice', { headers })
      if (sub?.object !== 'subscription' || sub.id !== id || sub.livemode !== live) throw providerFailure()
      const items = sub.items?.data
      const item = Array.isArray(items) && items.length === 1 && !sub.items.has_more && oneUnit(items[0]) ? items[0] : null
      let plan = planFor(prices, objectId(item?.price))
      let status = 'pending'
      if (['canceled', 'incomplete_expired'].includes(sub.status)) status = 'canceled'
      else if (['past_due', 'unpaid', 'paused'].includes(sub.status) || sub.pause_collection) status = 'past_due'
      else if (sub.status === 'active' && plan) {
        const paidPlan = await paidPlanForInvoice(sub.latest_invoice, id, item, plan)
        if (paidPlan) { plan = paidPlan; status = 'active' }
      }
      return { subscriptionId: id, ...association(sub.metadata), plan, status, periodEnd: unixSeconds(item?.current_period_end) }
    },
  }
}

function razorpayProvider(env, fetchImpl, now) {
  const key = setting(env, 'RAZORPAY_KEY_ID', /^rzp_(?:live|test)_[A-Za-z0-9]{1,240}$/)
  const secret = setting(env, 'RAZORPAY_KEY_SECRET')
  const signingKey = setting(env, 'RAZORPAY_WEBHOOK_SECRET')
  const planPattern = /^plan_[A-Za-z0-9]{1,240}$/
  const plans = planMap(setting(env, 'RAZORPAY_PLUS_PLAN_ID', planPattern), setting(env, 'RAZORPAY_ULTIMATE_PLAN_ID', planPattern))
  const count = Number(setting(env, 'RAZORPAY_TOTAL_COUNT', /^[1-9]\d{0,8}$/))
  const headers = { Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64') }
  const api = 'https://api.razorpay.com/v1/subscriptions'
  async function read(id) {
    checkedId(id)
    const sub = await providerJson(fetchImpl, api + '/' + id, { headers })
    if (sub?.entity !== 'subscription' || sub.id !== id) throw providerFailure()
    return sub
  }
  function openCheckout(sub) {
    const expiresAt = unixSeconds(sub.expire_by)
    if (sub.status !== 'created' || sub.paid_count !== 0 || sub.quantity !== 1 || !sub.short_url ||
      !expiresAt || expiresAt <= Math.floor(now() / 1000)) return null
    return { checkoutId: sub.id, url: hostedUrl(sub.short_url, ['https://rzp.io']), expiresAt }
  }
  return {
    async createCheckout({ tenantId, plan, attemptId }) {
      const expireBy = Math.floor(now() / 1000) + 1800
      const body = { plan_id: planId(plans, plan), total_count: count, quantity: 1, customer_notify: true,
        expire_by: expireBy, notes: { tenant_id: tenantId, attempt_id: attemptId } }
      const sub = await providerJson(fetchImpl, api, { method: 'POST', body: JSON.stringify(body),
        headers: { ...headers, 'Content-Type': 'application/json' } })
      checkedId(sub?.id)
      if (sub.entity !== 'subscription' || sub.plan_id !== body.plan_id ||
        sub.notes?.tenant_id !== tenantId || sub.notes?.attempt_id !== attemptId) throw providerFailure()
      const checkout = openCheckout(sub)
      if (!checkout) throw providerFailure()
      return checkout
    },
    async inspectCheckout(checkoutId) {
      const sub = await read(checkoutId)
      if (sub.status === 'created') return { state: 'open' }
      if (['expired', 'cancelled', 'completed'].includes(sub.status) && sub.paid_count === 0) return { state: 'closed' }
      if (['authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired'].includes(sub.status)) {
        return { state: 'subscribed', subscriptionId: sub.id }
      }
      throw providerFailure()
    },
    parseWebhook(bytes, requestHeaders) {
      if (!Buffer.isBuffer(bytes)) throw signedWebhookError()
      const mac = createHmac('sha256', signingKey).update(bytes).digest()
      if (!matchesMac(requestHeaders['x-razorpay-signature'], mac)) throw signedWebhookError()
      const event = eventJson(bytes)
      if (!razorpaySubscriptionEvents.has(event.event)) return null
      const entity = event.payload?.subscription?.entity
      if (event.entity !== 'event' || entity?.entity !== 'subscription' || typeof entity.id !== 'string' || !subscriptionIdPattern.test(entity.id)) throw signedWebhookError()
      // Razorpay signs the body but not its delivery-id header. Replays of the
      // same body therefore keep the same deduplication key even if that header changes.
      return { eventId: createHash('sha256').update(bytes).digest('hex'), subscriptionId: entity.id }
    },
    async getSubscription(id) {
      const sub = await read(id)
      const plan = sub.quantity === 1 ? planFor(plans, sub.plan_id) : null
      const periodEnd = unixSeconds(sub.current_end)
      let status = 'pending'
      if (['halted', 'pending', 'paused'].includes(sub.status)) status = 'past_due'
      if (['cancelled', 'completed', 'expired'].includes(sub.status)) status = 'canceled'
      const currentTime = Math.floor(now() / 1000)
      if (plan && periodEnd > currentTime && ['active', 'completed'].includes(sub.status) &&
        Number.isSafeInteger(sub.paid_count) && sub.paid_count > 0) {
        // Paying an *older* invoice can move a halted subscription back to active.
        const invoices = await providerJson(fetchImpl, 'https://api.razorpay.com/v1/invoices?subscription_id=' + id, { headers })
        if (invoices?.entity !== 'collection' || !Array.isArray(invoices.items)) throw providerFailure()
        if (invoices.items.some(invoice => invoice?.entity === 'invoice' && invoice.subscription_id === id &&
          invoice.status === 'paid' && invoice.amount_due === 0 && unixSeconds(invoice.billing_start) &&
          invoice.billing_start <= currentTime && invoice.billing_end === periodEnd)) status = 'active'
      }
      const snapshot = { subscriptionId: id, ...association(sub.notes), plan, status, periodEnd }
      if (plan && snapshot.tenantId && snapshot.attemptId) {
        const checkout = openCheckout(sub)
        if (checkout) snapshot.checkout = checkout
      }
      return snapshot
    },
  }
}

export function createBillingProviders({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  return {
    stripe: enabled(env, 'STRIPE_BILLING_ENABLED') ? stripeProvider(env, fetchImpl, now) : null,
    razorpay: enabled(env, 'RAZORPAY_BILLING_ENABLED') ? razorpayProvider(env, fetchImpl, now) : null,
  }
}
