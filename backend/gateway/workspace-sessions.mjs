import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { organizationUrl, organizationSlugFromHost } from '../../shared/organization-url.mjs'
import { problem } from './store.mjs'

const hash = (value) => createHash('sha256').update(value).digest('base64url')
export function registerWorkspaceSessions(app, { auth, authority, organizations, now = Date.now }) {
  const tickets = new Map()
  const clean = () => { for (const [id, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(id) }
  app.addHook('onClose', async () => tickets.clear())
  app.post('/api/auth/workspace-link', { onRequest: auth.requireIdentity, config: { rateLimit: { max: 20 } }, schema: { body: {
    type: 'object', required: ['organizationId','refreshToken','challenge','state'], additionalProperties: false,
    properties: {
      organizationId: { type: 'string', format: 'uuid' }, refreshToken: { type: 'string', minLength: 1, maxLength: 4096 },
      challenge: { type: 'string', pattern: '^[a-zA-Z0-9_-]{43}$' }, state: { type: 'string', format: 'uuid' },
    },
  } } }, async (request) => {
    if (request.headers.origin !== organizations.appOrigin) throw problem(403, 'Open this workspace from your organization directory.')
    const items = await authority.list(request.accessToken, request.subject)
    const organization = items.find((item) => item.id === request.body.organizationId)
    if (!organization) throw problem(403, 'You do not have access to this organization.')
    clean()
    if (tickets.size >= 1000) throw problem(503, 'Sign-in is busy. Try again shortly.')
    const code = randomBytes(32).toString('base64url')
    tickets.set(code, { accessToken: request.accessToken, refreshToken: request.body.refreshToken, subject: request.subject,
      organizationId: organization.id, slug: organization.slug, challenge: request.body.challenge, expires: now() + 60_000 })
    const url = new URL(organizationUrl(organization.slug, organizations))
    url.hash = new URLSearchParams({ 'workspace-code': code, state: request.body.state }).toString()
    return { url: url.href }
  })
  app.post('/api/auth/workspace-session', { config: { rateLimit: { max: 20 } }, schema: { body: {
    type: 'object', required: ['code','verifier'], additionalProperties: false,
    properties: { code: { type: 'string', pattern: '^[a-zA-Z0-9_-]{43}$' }, verifier: { type: 'string', pattern: '^[a-zA-Z0-9_-]{43,128}$' } },
  } } }, async (request) => {
    clean()
    const ticket = tickets.get(request.body.code)
    if (!ticket) throw problem(401, 'This workspace sign-in has expired. Try again.')
    const received = Buffer.from(hash(request.body.verifier)), expected = Buffer.from(ticket.challenge)
    const targetOrigin = new URL(organizationUrl(ticket.slug, organizations)).origin
    if (request.headers.origin !== targetOrigin || organizationSlugFromHost(request.headers.host, organizations) !== ticket.slug ||
      received.length !== expected.length || !timingSafeEqual(received, expected)) throw problem(401, 'This workspace sign-in could not be verified.')
    // Consume before awaiting any external permission check: only one exchange can succeed.
    tickets.delete(request.body.code)
    const role = await authority.membership(ticket.accessToken, ticket.organizationId, ticket.subject, ticket.slug)
    if (!role) throw problem(403, 'You no longer have access to this organization.')
    return { access_token: ticket.accessToken, refresh_token: ticket.refreshToken, userId: ticket.subject }
  })
}
