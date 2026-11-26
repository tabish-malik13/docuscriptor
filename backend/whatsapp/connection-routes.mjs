import { timingSafeEqual } from 'node:crypto'
import { credentialDigest } from '../gateway/client-credentials.mjs'
import { adminRoles } from '../gateway/tenant-authority.mjs'
import { problem } from '../gateway/store.mjs'

const path = '/api/tenant/whatsapp'
const uuid = { type: 'string', format: 'uuid' }
const credential = { type: 'string', minLength: 24, maxLength: 8192, pattern: '^[!-~]+$' }
const body = {
  type: 'object', required: ['revision','version','phoneNumberId','clientId','senders'], additionalProperties: false,
  properties: {
    revision: { anyOf: [uuid, { type: 'null' }] },
    version: { type: 'string', pattern: '^v[1-9][0-9]{0,2}\\.[0-9]{1,2}$' },
    phoneNumberId: { type: 'string', pattern: '^[0-9]{1,32}$' },
    clientId: uuid, appSecret: credential, accessToken: credential,
    clientSecret: { type: 'string', pattern: '^dss_[A-Za-z0-9_-]{43}$' },
    rotateVerifyToken: { type: 'boolean' },
    senders: { type: 'array', minItems: 1, maxItems: 250, uniqueItems: true, items: {
      type: 'string', pattern: '^(?:[1-9][0-9]{5,14}|[A-Z]{2}\\.[A-Za-z0-9]{1,128})$',
    } },
  },
}

export function registerWhatsAppConnectionRoutes(app, { connections, auth, authority, store, appOrigin }) {
  const admin = { onRequest: auth.requireAdmin, logLevel: 'silent' }
  const mutate = { ...admin, config: { rateLimit: { max: 12 } }, preHandler: async (request) => {
    const role = await authority.membership(request.accessToken, request.tenantId, request.subject, request.organizationSlug)
    if (!adminRoles.has(role)) throw problem(403, 'Organization administrator access is required.')
  } }
  function clientCredentialValid(tenantId, id, secret) {
    const client = store.clientCredential(id)
    const matches = timingSafeEqual(client?.secretHash ?? Buffer.alloc(32), credentialDigest(secret))
    return matches && client?.tenantId === tenantId
  }
  function describe(connection) {
    if (!connection) return null
    const { id, revision, version, phoneNumberId, clientId, senders, updatedAt, verifiedAt } = connection
    const callbackUrl = new URL('/api/integrations/whatsapp/webhook/' + id, appOrigin).href
    return { id, revision, version, phoneNumberId, clientId, senders, updatedAt, verifiedAt, callbackUrl,
      deploymentConflict: connections.deploymentConflict(connection),
      clientCredentialValid: clientCredentialValid(connection.tenantId, clientId, connection.clientSecret) }
  }
  app.get(path, admin, async request => ({
    connection: describe(connections.getByTenant(request.tenantId)), clients: store.activeClients(request.tenantId),
    deploymentManagedNumbers: connections.deploymentManagedNumbers(request.tenantId),
  }))
  app.put(path, { ...mutate, bodyLimit: 96 * 1024, attachValidation: true, schema: { body } }, async request => {
    if (request.validationError) throw problem(400, 'Check the Graph version, business phone number ID, allowed senders and credential formats.')
    const { connection, issuedVerifyToken } = connections.save(request.tenantId, request.body, (id, secret) => {
      if (!clientCredentialValid(request.tenantId, id, secret)) throw problem(400, 'Use an active API client and its current secret from this organization.')
    })
    return { connection: describe(connection), ...(issuedVerifyToken && { verifyToken: issuedVerifyToken }) }
  })
  app.delete(path, { ...mutate, schema: { querystring: {
    type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: uuid },
  } } }, async (request, reply) => {
    connections.remove(request.tenantId, request.query.revision)
    return reply.code(204).send()
  })
}
