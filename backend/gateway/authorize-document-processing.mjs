import { processingRoles, adminRoles, uuidPattern } from './tenant-authority.mjs'

export function createAuthorizers({
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = fetch,
  resolveTenant,
} = {}) {
  if (publishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key.')
  }
  if (supabaseUrl) {
    const url = new URL(supabaseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('SUPABASE_URL must be the Supabase project origin.')
    }
  }
  const userEndpoint = supabaseUrl ? new URL('/auth/v1/user', supabaseUrl) : null
  async function requireIdentity(request, reply) {
    const [scheme, token, extra] = (request.headers.authorization || '').split(' ')
    if (scheme !== 'Bearer' || !token || extra !== undefined || token.length > 8192) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ message: 'Sign in to continue.' })
    }
    if (!userEndpoint || !publishableKey) {
      return reply.code(503).send({ message: 'Supabase Auth has not been configured.' })
    }
    let user
    try {
      const response = await fetchImpl(userEndpoint, {
        headers: { apikey: publishableKey, Authorization: 'Bearer ' + token },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) {
          return reply.code(401).header('WWW-Authenticate', 'Bearer error="invalid_token"').send({ message: 'Your session is invalid or expired.' })
        }
        throw new Error('Supabase Auth request failed')
      }
      user = await response.json()
    } catch {
      return reply.code(503).send({ message: 'Supabase Auth is temporarily unavailable.' })
    }
    if (!user || user.is_anonymous || user.aud !== 'authenticated' || typeof user.id !== 'string' || !uuidPattern.test(user.id) ||
      !user.email_confirmed_at || typeof user.email !== 'string' || !user.email) {
      return reply.code(403).send({ message: 'This account cannot access the workspace.' })
    }
    request.subject = user.id
    request.accessToken = token
    request.email = user.email.toLowerCase()
  }
  async function requireTenant(request, reply) {
    await requireIdentity(request, reply)
    if (reply.sent) return
    const id = request.headers['x-tenant-id']
    if (typeof id !== 'string' || !uuidPattern.test(id)) {
      return reply.code(400).send({ message: 'Select a tenant before accessing workspace documents.' })
    }
    const role = await resolveTenant(request.accessToken, id.toLowerCase(), request.subject, request.organizationSlug)
    if (!role) return reply.code(403).send({ message: 'You are not a member of this tenant.' })
    request.tenantId = id.toLowerCase()
    request.tenantRole = role
    request.canProcess = processingRoles.has(role)
  }
  async function requireProcessing(request, reply) {
    await requireTenant(request, reply)
    if (reply.sent) return
    if (!request.canProcess) return reply.code(403).send({ message: 'Your tenant role cannot process documents.' })
  }
  async function requireAdmin(request, reply) {
    await requireTenant(request, reply)
    if (reply.sent) return
    if (!adminRoles.has(request.tenantRole)) return reply.code(403).send({ message: 'Tenant administrator access is required.' })
  }
  async function recheckProcessing(request) {
    const role = await resolveTenant(request.accessToken, request.tenantId, request.subject, request.organizationSlug)
    if (!processingRoles.has(role)) {
      const error = new Error('Your tenant processing permission has changed.')
      error.statusCode = 403; error.publicMessage = error.message
      throw error
    }
  }
  return { requireIdentity, requireTenant, requireProcessing, requireAdmin, recheckProcessing }
}
