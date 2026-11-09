import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGatewayApp } from '../gateway/app.mjs'
import { buildDocxApp } from '../docx/app.mjs'
import { buildPdfApp } from '../pdf/app.mjs'
import { createStore } from '../gateway/store.mjs'
import { problem } from '../../shared/problems.mjs'

// Principals exist only inside these tests. No accounts or seeded application data are created.
export async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const docxSecret = randomBytes(32).toString('hex')
  const pdfSecret = randomBytes(32).toString('hex')
  const rendererPassword = randomBytes(32).toString('hex')
  const subjects = new Map()
  const memberships = new Map()
  const tenants = new Map()
  function setRole(principal, role, tenantId = principal.tenantId) {
    const key = tenantId + ':' + principal.user.id
    if (role === null) memberships.delete(key)
    else memberships.set(key, role)
  }
  function principal(role = 'operator', tenantId = randomUUID()) {
    const token = randomBytes(32).toString('hex')
    const user = { id: randomUUID(), aud: 'authenticated', email: randomUUID() + '@test.invalid', email_confirmed_at: new Date().toISOString(), app_metadata: {} }
    subjects.set(token, user)
    tenants.set(tenantId, { id: tenantId, name: 'Isolated test organization', slug: 'org-' + tenantId })
    const person = { user, token, tenantId, headers: { authorization: 'Bearer ' + token, 'x-tenant-id': tenantId } }
    setRole(person, role)
    return person
  }
  const tenantAuthority = {
    async membership(token, tenantId, subject, slug) {
      if (options.membershipFailure) throw problem(503, 'Tenant permissions are temporarily unavailable.')
      if (slug && tenants.get(tenantId)?.slug !== slug) return null
      return subjects.get(token)?.id === subject ? memberships.get(tenantId + ':' + subject) || null : null
    },
    async list(token, subject) {
      return [...tenants.values()].filter((tenant) => memberships.has(tenant.id + ':' + subject))
        .map((tenant) => ({ ...tenant, role: memberships.get(tenant.id + ':' + subject) }))
    },
    async create(token, name, slug) {
      const user = subjects.get(token), id = randomUUID()
      tenants.set(id, { id, name, slug }); memberships.set(id + ':' + user.id, 'owner')
      return { id, name, slug, role: 'owner' }
    },
    async members(token, tenantId) {
      return [...subjects.values()].filter((user) => memberships.has(tenantId + ':' + user.id))
        .map((user) => ({ user_id: user.id, email: user.email, role: memberships.get(tenantId + ':' + user.id) }))
    },
    async invitations() { return [] },
    async audit() { return [] },
    async setRole(token, tenantId, userId, role) {
      if (role === null) memberships.delete(tenantId + ':' + userId)
      else memberships.set(tenantId + ':' + userId, role)
    },
  }
  let authCalls = 0
  const authOptions = {
    supabaseUrl: 'http://identity.invalid', publishableKey: 'sb_publishable_test',
    fetchImpl: async (_url, request) => {
      authCalls++
      if (options.authFailure) throw new Error('Offline identity provider')
      const user = subjects.get(request.headers.Authorization.slice(7))
      return Response.json(user || {}, { status: user ? 200 : 401 })
    },
  }
  const docx = buildDocxApp({ secret: docxSecret, logger: false })
  let rendererCalls = 0
  const pdf = buildPdfApp({ secret: pdfSecret, rendererPassword, logger: false,
    fetchImpl: async (_url, request) => {
      rendererCalls++
      if (request.headers.Authorization !== 'Basic ' + Buffer.from('docuscripter:' + rendererPassword).toString('base64')) throw new Error('Missing renderer credentials')
      if (options.rendererFailure) return new Response('Unavailable', { status: 503 })
      if (options.invalidPdf) return new Response('Not a PDF')
      return new Response('%PDF-1.7\n%%EOF', { headers: { 'Content-Type': 'application/pdf' } })
    },
  })
  const fetchImpl = async (url, request) => {
    if (options.transportFailure) throw new TypeError('Unreachable service')
    const parsed = new URL(url)
    const app = parsed.hostname === 'docx.invalid' ? docx : pdf
    const result = await app.inject({ method: request.method, url: parsed.pathname, headers: request.headers, payload: request.body })
    if (options.onServiceResult) await options.onServiceResult()
    return new Response(result.rawPayload, { status: result.statusCode, headers: result.headers })
  }
  const gatewayOptions = { documentStore: options.documentStore || createStore(join(dir,'workspace.sqlite')), storageOptions: options.storageOptions, storePath: join(dir, 'workspace.sqlite'), docxService: 'http://docx.invalid', pdfService: 'http://pdf.invalid', docxSecret, pdfSecret, authOptions, tenantAuthority, fetchImpl, logger: false, ...(options.organizationOptions ? { organizationOptions: options.organizationOptions } : {}) }
  let gateway = await buildGatewayApp(gatewayOptions)
  t.after(async () => { await gateway.close(); await docx.close(); await pdf.close() })
  return {
    get gateway() { return gateway }, docx, pdf, docxSecret, pdfSecret, principal, setRole,
    organizationSlug: (id) => tenants.get(id)?.slug,
    get authCalls() { return authCalls }, get rendererCalls() { return rendererCalls },
    async restart() { await gateway.close(); gatewayOptions.documentStore = createStore(join(dir,'workspace.sqlite')); gateway = await buildGatewayApp(gatewayOptions) },
    dir,
  }
}

export const invoiceValues = () => ({ invoice_number: '1', customer_name: '', description: 'Document pipeline verification', amount_due: '0' })
