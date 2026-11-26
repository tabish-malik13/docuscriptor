import { organizationUrl } from '../../shared/organization-url.mjs'
import { problem } from '../gateway/store.mjs'

export async function registerBillingRoutes(app, { auth, authority, organizations, billing, store }) {
  async function owner(request, reply) {
    await auth.requireTenant(request, reply)
    if (!reply.sent && request.tenantRole !== 'owner') throw problem(403, 'Only the organization owner can manage billing.')
  }
  async function recheckOwner(request) {
    const role = await authority.membership(request.accessToken, request.tenantId, request.subject, request.organizationSlug)
    auth.assertSessionActive(request.subject, request.accessToken)
    if (role !== 'owner') throw problem(403, 'Organization ownership is required to manage billing.')
  }
  const status = request => billing.describe(request.tenantId, store.billingUsage(request.tenantId))
  const mutation = { onRequest: owner, preHandler: recheckOwner, config: { rateLimit: { max: 10 } } }
  app.get('/api/billing', { onRequest: owner }, async request => status(request))
  app.post('/api/billing/checkout', { ...mutation, schema: { body: {
    type: 'object', additionalProperties: false, required: ['provider','plan'],
    properties: { provider: { enum: ['stripe','razorpay'] }, plan: { enum: ['plus','ultimate'] } },
  } } }, async request => {
    const slug = request.organizationSlug || (await authority.list(request.accessToken, request.subject)).find(row => row.id === request.tenantId)?.slug
    if (!slug) throw problem(403, 'Choose an organization before starting checkout.')
    const url = new URL(organizationUrl(slug, organizations))
    if (request.body.provider === 'stripe') url.searchParams.set('stripe_checkout', 'success')
    url.hash = 'billing'
    const result = await billing.checkout(request.tenantId, request.body.provider, request.body.plan, url.href)
    await recheckOwner(request)
    return result
  })
  app.post('/api/billing/refresh', { ...mutation, schema: { body: {
    type: 'object', additionalProperties: false,
    properties: { subscriptionId: { type: 'string', pattern: '^sub_[A-Za-z0-9]{1,240}$' } },
  } } }, async request => {
    await billing.refresh(request.tenantId, request.body?.subscriptionId)
    await recheckOwner(request)
    return status(request)
  })
  await app.register(async webhooks => {
    webhooks.removeContentTypeParser('application/json')
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, bytes, done) => done(null, bytes))
    webhooks.post('/api/billing/webhooks/:provider', { logLevel: 'silent', bodyLimit: 512 * 1024, config: { rateClass: 'webhook' },
      schema: { params: { type: 'object', properties: { provider: { enum: ['stripe','razorpay'] } } } },
    }, async (request, reply) => {
      await billing.webhook(request.params.provider, request.body, request.headers)
      return reply.code(204).send()
    })
  })
}
