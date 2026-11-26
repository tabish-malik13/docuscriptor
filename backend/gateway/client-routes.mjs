import { timingSafeEqual } from 'node:crypto'
import {
  accessTokenLifetime, clientScopes, credentialDigest, isClientSecret, matchesClientTenant,
  newAccessToken, newClientSecret, organizationTemplateEditScope,
} from './client-credentials.mjs'
import { adminRoles, uuidPattern } from './tenant-authority.mjs'
import { problem } from './store.mjs'

const clientParams = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
}
const invalidClient = (reply) => reply.code(401).header('WWW-Authenticate', 'Basic realm="DocuScripter"').send({ error: 'invalid_client' })

function basicCredentials(header) {
  if (typeof header !== 'string' || header.length > 256) return null
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header)
  if (!match) return null
  const [id, secret, extra] = Buffer.from(match[1], 'base64').toString('utf8').split(':')
  return uuidPattern.test(id) && isClientSecret(secret) && extra === undefined ? { id, secret } : null
}

export function registerClientRoutes(app, { auth, authority, store, features }) {
  const availableScopes = clientScopes.filter(scope =>
    (features.templateApiEdits || scope !== organizationTemplateEditScope) && (features.templateDeletion || scope !== 'templates:delete'))
  const provisionSchema = {
    type: 'object', required: ['name', 'scopes'], additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
      scopes: { type: 'array', minItems: 1, maxItems: availableScopes.length, uniqueItems: true, items: { type: 'string', enum: availableScopes } },
    },
  }
  const admin = { onRequest: auth.requireAdmin }
  // onRequest protects the body parser. Verify the role again after the body arrives
  // and immediately before changing the credential. Provisioning uses the list check below.
  const changeClient = { ...admin, schema: { params: clientParams }, preHandler: async (request) => {
    const role = await authority.membership(request.accessToken, request.tenantId, request.subject, request.organizationSlug)
    if (!adminRoles.has(role)) throw problem(403, 'Tenant administrator access is required.')
  } }
  app.post('/api/tenant/clients', { ...admin, schema: { body: provisionSchema } }, async (request, reply) => {
    const organizations = await authority.list(request.accessToken, request.subject)
    const tenant = organizations.find((item) => item.id === request.tenantId)
    // Members can use the central gateway with no hostname slug. Persist the authoritative
    // immutable workspace slug so scoped hosts and path-mode requests can still be checked.
    if (!tenant?.slug || !adminRoles.has(tenant.role)) throw problem(403, 'Tenant administrator access is required.')
    const clientSecret = newClientSecret()
    const client = store.createClient(tenant.id, tenant.slug, request.body.name.trim(), request.body.scopes, credentialDigest(clientSecret), request.subject)
    return reply.code(201).send({ ...client, clientSecret })
  })
  app.get('/api/tenant/clients', { ...admin, schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})$' } },
  } } }, async (request) => {
    const offset = Number(request.query.offset || 0)
    const clients = store.listClients(request.tenantId, offset, 51)
    return { items: clients.slice(0, 50), nextOffset: clients.length > 50 ? offset + 50 : null }
  })
  app.post('/api/tenant/clients/:id/rotate', changeClient, async (request) => {
    const clientSecret = newClientSecret()
    const client = store.rotateClient(request.tenantId, request.params.id, request.subject, credentialDigest(clientSecret))
    return { ...client, clientSecret }
  })
  app.delete('/api/tenant/clients/:id', changeClient, async (request, reply) => {
    store.revokeClient(request.tenantId, request.params.id, request.subject)
    return reply.code(204).send()
  })

  // Encapsulate the form parser so existing JSON document endpoints keep their content types.
  app.register(async (oauth) => {
    oauth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body))
    oauth.post('/api/oauth/token', { config: { rateClass: 'token' }, bodyLimit: 2048 }, async (request, reply) => {
      reply.header('Pragma', 'no-cache')
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' || typeof request.body !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const form = new URLSearchParams(request.body)
      if (form.getAll('grant_type').length !== 1 || form.getAll('scope').length > 1 || form.has('client_secret') || form.has('client_id')) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      if (form.get('grant_type') !== 'client_credentials') return reply.code(400).send({ error: 'unsupported_grant_type' })
      const credentials = basicCredentials(request.headers.authorization)
      if (!credentials) return invalidClient(reply)
      const client = store.clientCredential(credentials.id)
      const hash = credentialDigest(credentials.secret)
      if (!timingSafeEqual(client?.secretHash ?? Buffer.alloc(32), hash) || !client || !matchesClientTenant(client, request)) return invalidClient(reply)

      const granted = client.scopes.filter(scope => availableScopes.includes(scope))
      const scopes = form.has('scope') ? form.get('scope').split(' ') : granted
      if (!scopes.length || new Set(scopes).size !== scopes.length || !scopes.every((scope) => granted.includes(scope))) {
        return reply.code(400).send({ error: 'invalid_scope' })
      }
      const token = newAccessToken()
      const issued = store.issueClientToken(client.id, hash, credentialDigest(token), scopes, Date.now() + accessTokenLifetime * 1000)
      if (issued.retryAfter) return reply.code(429).header('Retry-After', String(issued.retryAfter)).send({
        error: 'temporarily_unavailable', error_description: 'Too many active tokens. Reuse an existing token or wait for it to expire.',
      })
      if (!issued.created) return invalidClient(reply)
      return { access_token: token, token_type: 'Bearer', expires_in: accessTokenLifetime, scope: scopes.join(' ') }
    })
  })
}
