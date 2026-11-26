import { fileURLToPath } from 'node:url'
import { createService } from '../shared/http-service.mjs'
import { requireSecret } from '../shared/service-authorization.mjs'
import { registerDocumentRoutes } from './document-routes.mjs'
import { createAuthorizers } from './authorize-document-processing.mjs'
import { createStore, problem } from './store.mjs'
import { createTenantAuthority } from './tenant-authority.mjs'
import { organizationConfig, organizationSlugFromHost, validOrganizationSlug } from '../../shared/organization-url.mjs'
import { registerWorkspaceSessions } from './workspace-sessions.mjs'
import { registerTenantRoutes } from './tenant-routes.mjs'
import { registerClientRoutes } from './client-routes.mjs'
import { credentialDigest } from './client-credentials.mjs'
import { registerGatewayRateLimits, rateLimitTrustedProxies } from './rate-limits.mjs'
import { loadWhatsAppConfig, registerWhatsApp } from '../whatsapp/webhook.mjs'
import { openWhatsAppConnections } from '../whatsapp/connections.mjs'
import { registerWhatsAppConnectionRoutes } from '../whatsapp/connection-routes.mjs'
import { createLicenseCatalog } from '../billing/catalog.mjs'
import { createBilling } from '../billing/billing.mjs'
import { registerBillingRoutes } from '../billing/routes.mjs'

export async function buildGatewayApp({
  storePath = process.env.DATA_PATH || fileURLToPath(new URL('../../.data/workspace.sqlite', import.meta.url)),
  docxService = process.env.DOCX_SERVICE_URL || 'http://127.0.0.1:4001',
  pdfService = process.env.PDF_SERVICE_URL || 'http://127.0.0.1:4002',
  docxSecret = process.env.DOCX_SERVICE_SECRET,
  pdfSecret = process.env.PDF_SERVICE_SECRET,
  organizationOptions = organizationConfig(process.env.APP_ORIGIN || process.env.VITE_APP_ORIGIN || 'http://127.0.0.1:5173', process.env.ORGANIZATION_BASE_DOMAIN || process.env.VITE_ORGANIZATION_BASE_DOMAIN || 'docuscriptor.localhost', process.env.ORGANIZATION_ROUTING || process.env.VITE_ORGANIZATION_ROUTING || 'subdomain'),
  authOptions, tenantAuthority, fetchImpl = fetch, logger, rateLimits, whatsappOptions, billingOptions,
} = {}) {
  requireSecret(docxSecret, 'DOCX_SERVICE_SECRET')
  requireSecret(pdfSecret, 'PDF_SERVICE_SECRET')
  if (docxSecret === pdfSecret) throw new Error('Use different secrets for DOCX and PDF services.')
  const authority = tenantAuthority || createTenantAuthority(authOptions)
  const app = createService({ logger, trustProxy: rateLimitTrustedProxies() })
  const catalog = createLicenseCatalog(billingOptions?.env ?? process.env)
  const billing = createBilling({ ...billingOptions, storePath, catalog })
  app.addHook('onClose', async () => billing.close())
  const store = createStore(storePath, { limitsForTenant: tenant => catalog.limits(billing.planForTenant(tenant)) })
  app.addHook('onClose', async () => store.close())
  const auth = createAuthorizers({ ...authOptions, store, resolveTenant: authority.membership, requireOrganizationSlug: organizationOptions.routing === 'path' })
  app.decorateRequest('subject', null)
  app.decorateRequest('canProcess', false)
  app.decorateRequest('accessToken', null)
  app.decorateRequest('email', null)
  app.decorateRequest('displayName', null)
  app.decorateRequest('tenantId', null)
  app.decorateRequest('tenantRole', null)
  app.decorateRequest('organizationSlug', null)
  app.decorateRequest('clientScopes', null)
  registerGatewayRateLimits(app, { storePath, options: rateLimits })
  app.addHook('onRequest', async (request) => {
    try {
      if (organizationOptions.routing === 'path') {
        const slug = request.headers['x-organization-slug']
        if (slug !== undefined && !validOrganizationSlug(slug)) throw new Error('Invalid slug')
        request.organizationSlug = slug || null
      } else request.organizationSlug = organizationSlugFromHost(request.headers.host, organizationOptions)
    } catch { throw problem(400, 'This organization workspace address is invalid.') }
  })
  app.get('/api/health', async () => ({ status: 'ok' }))
  app.get('/api/auth/session', { onRequest: auth.requireIdentity }, async req => ({
    id: req.subject, name: req.displayName, email: req.email,
  }))
  app.post('/api/auth/sign-out', { onRequest: auth.requireSignOutIdentity }, async (req, reply) => {
    auth.endSession(req)
    return reply.code(204).send()
  })
  registerDocumentRoutes(app, { store, auth, docxService, pdfService, docxSecret, pdfSecret, fetchImpl })
  registerTenantRoutes(app, { store, auth, authority })
  registerClientRoutes(app, { store, auth, authority })
  await registerBillingRoutes(app, { auth, authority, organizations: organizationOptions, billing, store })
  if (organizationOptions.routing !== 'path') registerWorkspaceSessions(app, { auth, authority, organizations: organizationOptions })
  const configPath = whatsappOptions?.configPath === undefined ? process.env.WHATSAPP_CONFIG_FILE : whatsappOptions.configPath
  const legacyConfig = loadWhatsAppConfig(configPath)
  const connections = openWhatsAppConnections({ storePath, configuredKey: whatsappOptions?.encryptionKey, legacyConfig })
  app.addHook('onClose', async () => connections.close())
  registerWhatsAppConnectionRoutes(app, { connections, store, auth, authority, appOrigin: organizationOptions.appOrigin })
  await registerWhatsApp(app, { ...whatsappOptions, connections, legacyConfig, storePath, resolveClientToken: (token) => store.resolveClientToken(credentialDigest(token)) })
  return app
}
