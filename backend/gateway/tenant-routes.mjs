import { organizationSlugPattern, reservedSlugs } from '../../shared/organization-url.mjs'
import { problem } from './store.mjs'

const id = { type: 'string', format: 'uuid' }
const params = { type: 'object', required: ['id'], additionalProperties: false, properties: { id } }
const name = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }
const roles = ['owner', 'admin', 'operator', 'viewer']

export function registerTenantRoutes(app, { auth, authority, store }) {
  const account = { onRequest: auth.requireIdentity }
  const tenant = { onRequest: auth.requireTenant }
  const admin = { onRequest: auth.requireAdmin }
  app.get('/api/organizations', account, async (request) => ({ items: await authority.list(request.accessToken, request.subject) }))
  app.post('/api/organizations', { ...account, config: { rateLimit: { max: 10 } }, schema: { body: {
    type: 'object', required: ['name','slug'], additionalProperties: false, properties: { name, slug: { type: 'string', pattern: organizationSlugPattern, not: { enum: [...reservedSlugs] } } },
  } } }, async (request, reply) => reply.code(201).send(await authority.create(request.accessToken, request.body.name, request.body.slug)))
  app.patch('/api/tenant', { ...admin, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name } } } }, async (request, reply) => {
    await authority.rename(request.accessToken, request.tenantId, request.body.name)
    return reply.code(204).send()
  })
  app.get('/api/invitations', account, async (request) => ({ items: await authority.invitations(request.accessToken, null, request.email) }))
  app.post('/api/invitations/:id/accept', { ...account, schema: { params } }, async (request) => ({ tenantId: await authority.accept(request.accessToken, request.params.id) }))
  app.get('/api/tenant/membership', tenant, async (request) => ({ role: request.tenantRole, userId: request.subject }))
  app.get('/api/tenant/members', admin, async (request) => ({ items: await authority.members(request.accessToken, request.tenantId) }))
  app.patch('/api/tenant/members/:id', { ...admin, schema: { params, body: {
    type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: roles } },
  } } }, async (request, reply) => {
    await authority.setRole(request.accessToken, request.tenantId, request.params.id, request.body.role)
    return reply.code(204).send()
  })
  app.delete('/api/tenant/members/:id', { ...admin, schema: { params } }, async (request, reply) => {
    await authority.setRole(request.accessToken, request.tenantId, request.params.id, null)
    return reply.code(204).send()
  })
  app.post('/api/tenant/leave', tenant, async (request, reply) => {
    await authority.setRole(request.accessToken, request.tenantId, request.subject, null)
    return reply.code(204).send()
  })
  app.get('/api/tenant/invitations', admin, async (request) => ({ items: await authority.invitations(request.accessToken, request.tenantId) }))
  app.post('/api/tenant/invitations', { ...admin, config: { rateLimit: { max: 20 } }, schema: { body: {
    type: 'object', required: ['email', 'role'], additionalProperties: false,
    properties: { email: { type: 'string', format: 'email', maxLength: 254 }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'] } },
  } } }, async (request, reply) => reply.code(201).send({ id: await authority.invite(request.accessToken, request.tenantId, request.body.email, request.body.role) }))
  app.delete('/api/tenant/invitations/:id', { ...admin, schema: { params } }, async (request, reply) => {
    await authority.revoke(request.accessToken, request.tenantId, request.params.id)
    return reply.code(204).send()
  })
  app.get('/api/tenant/audit', admin, async (request) => ({ items: await authority.audit(request.accessToken, request.tenantId) }))
  app.get('/api/personal-records', account, async (request) => store.legacySummary(request.subject))
  app.post('/api/tenant/import-personal', { ...admin, schema: { body: {
    type: 'object', required: ['shareWithTenant'], additionalProperties: false, properties: { shareWithTenant: { const: true } },
  } } }, async (request) => {
    if (request.tenantRole !== 'owner') throw problem(403, 'Tenant ownership is required to import personal records.')
    return store.importLegacy(request.tenantId, request.subject)
  })
}
