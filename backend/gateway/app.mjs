import rateLimit from '@fastify/rate-limit'
import { createService } from '../shared/http-service.mjs'
import { requireSecret } from '../shared/service-authorization.mjs'
import { registerDocumentRoutes } from './document-routes.mjs'
import { createAuthorizers } from './authorize-document-processing.mjs'
import { createSupabaseStore } from './supabase-store.mjs'
import { createTenantAuthority } from './tenant-authority.mjs'
import { organizationConfig, organizationSlugFromHost, validOrganizationSlug } from '../../shared/organization-url.mjs'
import { registerWorkspaceSessions } from './workspace-sessions.mjs'
import { problem } from '../../shared/problems.mjs'
import { registerTenantRoutes } from './tenant-routes.mjs'

export async function buildGatewayApp({
  docxService = process.env.DOCX_SERVICE_URL || 'http://127.0.0.1:4001',
  pdfService = process.env.PDF_SERVICE_URL || 'http://127.0.0.1:4002',
  docxSecret = process.env.DOCX_SERVICE_SECRET,
  pdfSecret = process.env.PDF_SERVICE_SECRET,
  organizationOptions = organizationConfig(process.env.APP_ORIGIN || process.env.VITE_APP_ORIGIN || 'http://127.0.0.1:5173', process.env.ORGANIZATION_BASE_DOMAIN || process.env.VITE_ORGANIZATION_BASE_DOMAIN || 'docuscriptor.localhost', process.env.ORGANIZATION_ROUTING || process.env.VITE_ORGANIZATION_ROUTING || 'subdomain'),
  documentStore, storageOptions, processingLimit = 4, healthCheck,
  authOptions, tenantAuthority, fetchImpl = fetch, logger,
} = {}) {
  requireSecret(docxSecret, 'DOCX_SERVICE_SECRET')
  requireSecret(pdfSecret, 'PDF_SERVICE_SECRET')
  if (docxSecret === pdfSecret) throw new Error('Use different secrets for DOCX and PDF services.')
  const authority = tenantAuthority || createTenantAuthority(authOptions)
  const auth = createAuthorizers({ ...authOptions, resolveTenant: authority.membership, requireOrganizationSlug: organizationOptions.routing === 'path' })
  const app = createService({ logger })
  app.decorateRequest('subject', null)
  app.decorateRequest('canProcess', false)
  app.decorateRequest('accessToken', null)
  app.decorateRequest('email', null)
  app.decorateRequest('tenantId', null)
  app.decorateRequest('tenantRole', null)
  app.decorateRequest('organizationSlug', null)
  await app.register(rateLimit, {
    global: true, hook: 'preParsing', max: 120, timeWindow: '1 minute',
    keyGenerator: (request) => request.subject ? (request.tenantId || 'account') + ':' + request.subject : request.ip,
  })
  const limitAuthentication = app.createRateLimit({
    max: 120, timeWindow: '1 minute', keyGenerator: (request) => 'auth:' + request.ip,
  })
  app.addHook('onRequest', async (request, reply) => {
    try {
      if (organizationOptions.routing === 'path') {
        const slug = request.headers['x-organization-slug']
        if (slug !== undefined && !validOrganizationSlug(slug)) throw new Error('Invalid slug')
        request.organizationSlug = slug || null
      } else request.organizationSlug = organizationSlugFromHost(request.headers.host, organizationOptions)
    } catch { throw problem(400, 'This organization workspace address is invalid.') }
    const result = await limitAuthentication(request)
    if (result.isExceeded) {
      return reply.code(429).header('Retry-After', result.ttlInSeconds).send({ message: 'Too many requests. Try again shortly.' })
    }
  })
  const store = documentStore || createSupabaseStore(storageOptions)
  app.addHook('onClose', async () => store.close())
  app.get('/api/health', async (_request,reply) => {
    if(healthCheck && !await healthCheck()) return reply.code(503).send({status:'unavailable'})
    return {status:'ok'}
  })
  registerDocumentRoutes(app, { store, auth, docxService, pdfService, docxSecret, pdfSecret, fetchImpl, processingLimit })
  registerTenantRoutes(app, { store, auth, authority })
  if (organizationOptions.routing !== 'path') registerWorkspaceSessions(app, { auth, authority, organizations: organizationOptions })
  return app
}
