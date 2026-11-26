import { openBillingStore } from './store.mjs'
import { createBillingProviders } from './providers.mjs'
import { problem } from '../gateway/store.mjs'

const day = 86_400_000
const supported = ['stripe', 'razorpay']
const paid = plan => plan === 'plus' || plan === 'ultimate'

export function createBilling({ storePath, catalog, env = process.env, providers, now = Date.now }) {
  const mode = env.BILLING_MODE || 'self-hosted'
  if (!['self-hosted','managed'].includes(mode)) throw new Error('BILLING_MODE must be self-hosted or managed.')
  const managed = mode === 'managed'
  const adapters = managed ? providers ?? createBillingProviders({ env, now }) : {}
  const db = managed ? openBillingStore(storePath === ':memory:' ? storePath : storePath + '.billing.sqlite') : null
  const creating = new Map()
  const refreshing = new Set()
  const enabled = provider => supported.includes(provider) && !!adapters[provider]
  const manual = tenant => catalog.manualPlan(tenant, now())

  function license(tenant, row) {
    if (!managed) return { plan: 'self-hosted', source: 'self-hosted' }
    const contract = manual(tenant)
    if (contract) return { plan: contract, source: 'contract' }
    if (row?.phase === 'subscription' && row.status === 'active' && paid(row.subscription_plan) && row.period_end * 1000 > now()) {
      return { plan: row.subscription_plan, source: 'subscription' }
    }
    return { plan: 'starter', source: 'included' }
  }

  async function synchronize(provider, subscriptionId, { tenant, attemptId, eventId } = {}) {
    if (!managed || !enabled(provider)) throw problem(503, 'This payment provider is unavailable.')
    const key = provider + '/' + subscriptionId
    if (eventId && db.seen(provider, eventId)) return
    // The deployment uses one gateway per SQLite volume. Concurrent remote reads for the
    // same subscription could complete out of order and apply a stale snapshot last.
    if (refreshing.has(key)) throw problem(503, 'Subscription status is updating. Retry shortly.')
    refreshing.add(key)
    try {
      const snapshot = await adapters[provider].getSubscription(subscriptionId)
      if (snapshot.subscriptionId !== subscriptionId) throw problem(502, 'The payment provider returned a different subscription.')
      if (tenant) {
        const bound = db.bySubscription(provider, subscriptionId)
        if (bound ? bound.tenant !== tenant || bound.id !== attemptId : snapshot.tenantId !== tenant || snapshot.attemptId !== attemptId) {
          throw problem(404, 'This subscription does not match the organization checkout.')
        }
      }
      const matched = db.sync(provider, snapshot, eventId, now())
      if (tenant && !matched) throw problem(409, 'The subscription no longer matches the pending checkout.')
    } finally { refreshing.delete(key) }
  }

  async function refresh(tenant, subscriptionId) {
    const row = db?.current(tenant)
    if (!row) {
      if (subscriptionId) throw problem(409, 'There is no checkout to reconcile.')
      return
    }
    const adapter = adapters[row.provider]
    if (!adapter) throw problem(503, 'Configure the original payment provider to check this subscription.')
    const expected = { tenant, attemptId: row.id }
    if (subscriptionId && row.subscription_id && subscriptionId !== row.subscription_id) throw problem(404, 'This subscription does not match the organization checkout.')
    if (subscriptionId || row.subscription_id) {
      await synchronize(row.provider, subscriptionId || row.subscription_id, expected)
    } else if (row.checkout_id) {
      const result = await adapter.inspectCheckout(row.checkout_id)
      if (result.state === 'subscribed') await synchronize(row.provider, result.subscriptionId, expected)
      if (result.state === 'closed') db.closeCheckout(row.id)
    } else if (row.provider === 'razorpay' || now() - row.created_at >= day - 3_600_000) {
      throw problem(409, 'The provider has not confirmed this checkout. Ask your billing administrator to reconcile the original subscription before starting another.')
    }
  }

  async function create(row, firstRequest) {
    if (creating.has(row.id)) return creating.get(row.id)
    const creation = (async () => {
      let checkout
      try {
        checkout = await adapters[row.provider].createCheckout({ tenantId: row.tenant, plan: row.plan, attemptId: row.id, returnUrl: row.return_url })
      } catch (error) {
        // Only release a reservation when the provider explicitly rejected the request.
        // A timeout or lost response can still leave a payable remote subscription.
        if (firstRequest && error.checkoutRejected === true) db.closeCheckout(row.id)
        throw error
      }
      db.attach(row.id, checkout)
      if (db.byId(row.id).phase !== 'checkout') throw problem(409, 'This checkout has already changed. Check payment status.')
      return { url: checkout.url }
    })()
    creating.set(row.id, creation)
    try { return await creation } finally { creating.delete(row.id) }
  }

  return {
    close: () => db?.close(),
    planForTenant: tenant => license(tenant, db?.current(tenant)).plan,
    describe(tenant, usage) {
      const row = db?.current(tenant)
      const { plan, source } = license(tenant, row)
      const pending = row && row.phase !== 'subscription' ? { provider: row.provider, plan: row.plan } : null
      const history = row?.phase === 'subscription' ? row : !row && db?.lastSubscription(tenant)
      const periodExpired = history?.status === 'active' && !(history.period_end * 1000 > now())
      const subscription = history ? { provider: history.provider, plan: history.subscription_plan || history.plan, status: periodExpired ? 'expired' : history.status,
        periodEnd: history.period_end ? new Date(history.period_end * 1000).toISOString() : null } : null
      const canCheckout = managed && source !== 'contract' && row?.phase !== 'subscription' && (pending ? enabled(row.provider) : supported.some(enabled))
      return { mode, plan, source, limits: catalog.limits(plan), usage, plans: catalog.plans, providers: {
        stripe: enabled('stripe'), razorpay: enabled('razorpay'),
      }, pending, subscription, canCheckout }
    },
    async checkout(tenant, provider, plan, returnUrl) {
      if (!managed || !enabled(provider)) throw problem(503, 'Online checkout is not configured for this payment provider.')
      if (manual(tenant)) throw problem(409, 'This organization has an administrator-provisioned contract license.')
      let row = db.current(tenant)
      if (row?.phase === 'checkout' && row.expires_at * 1000 <= now()) {
        // Expiry alone is not proof of abandonment: payment may have completed just before expiry.
        await refresh(tenant)
        row = db.current(tenant)
      }
      const fresh = !row
      row ??= db.start(tenant, provider, plan, returnUrl, now())
      if (row.phase === 'subscription') throw problem(409, 'This organization already has a subscription. Changes are managed with the current payment provider.')
      if (row.provider !== provider || row.plan !== plan) throw problem(409, 'This organization already has a pending checkout. Resume or reconcile it first.')
      if (row.phase === 'checkout') {
        if (row.expires_at * 1000 <= now()) throw problem(409, 'This checkout is awaiting confirmation from the payment provider.')
        return { url: row.url }
      }
      if (!fresh && !creating.has(row.id) && (provider !== 'stripe' || now() - row.created_at >= day - 3_600_000)) {
        throw problem(409, 'The original checkout is awaiting provider reconciliation. Check payment status before retrying.')
      }
      return create(row, fresh)
    },
    refresh,
    async webhook(provider, body, headers) {
      if (!enabled(provider)) throw problem(404, 'This billing webhook is not configured.')
      const event = adapters[provider].parseWebhook(body, headers)
      if (event) await synchronize(provider, event.subscriptionId, { eventId: event.eventId })
    },
  }
}
