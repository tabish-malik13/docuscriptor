import { createHash } from 'node:crypto'
import { processingRoles, adminRoles, uuidPattern } from './tenant-authority.mjs'
import { clientScopes, credentialDigest, isAccessToken, matchesClientTenant, organizationTemplateEditScope } from './client-credentials.mjs'
import { problem } from './store.mjs'

// Called only after Supabase has verified this token and its subject.
// Refreshed Supabase JWTs retain their session_id. Older opaque credentials
// can still be invalidated by their exact token without retaining it.
function sessionDigest(subject, token) {
  let id
  const parts = token.split('.')
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (claims.sub === subject && typeof claims.session_id === 'string' && uuidPattern.test(claims.session_id)) id = claims.session_id.toLowerCase()
    } catch { /* Verified legacy tokens may have no session identifier. */ }
  }
  return createHash('sha256').update(JSON.stringify([subject, id ? 'session' : 'token', id || token])).digest()
}

export function createAuthorizers({
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = fetch,
  resolveTenant,
  store,
  requireOrganizationSlug = false,
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
  function assertSessionActive(subject, token) {
    if (store.sessionEnded(sessionDigest(subject, token))) throw problem(401, 'Your session has ended. Sign in again.')
  }
  async function verifiedIdentity(request, reply, allowEndedSession = false) {
    const header = request.headers.authorization || ''
    const token = header.length <= 8199 && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header)?.[1]
    if (!token || /^(dsa_|dss_)/i.test(token)) {
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
    if (!allowEndedSession) assertSessionActive(user.id, token)
    request.subject = user.id
    request.accessToken = token
    request.email = user.email.toLowerCase()
    request.displayName = (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()) || user.email
  }
  const requireIdentity = (request, reply) => verifiedIdentity(request, reply)
  const requireSignOutIdentity = (request, reply) => verifiedIdentity(request, reply, true)
  async function requireTenant(request, reply) {
    await requireIdentity(request, reply)
    if (reply.sent) return
    if (requireOrganizationSlug && !request.organizationSlug) {
      return reply.code(400).send({ message: 'Open an organization workspace before accessing its documents.' })
    }
    const id = request.headers['x-tenant-id']
    if (typeof id !== 'string' || !uuidPattern.test(id)) {
      return reply.code(400).send({ message: 'Select a tenant before accessing workspace documents.' })
    }
    const role = await resolveTenant(request.accessToken, id.toLowerCase(), request.subject, request.organizationSlug)
    assertSessionActive(request.subject, request.accessToken)
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
  function scopedDocumentAccess(scopes, readOnly) {
    for (const scope of scopes) {
      if (!clientScopes.includes(scope)) throw new Error('Unknown document API scope: ' + scope)
    }
    return async (request, reply) => {
      const match = /^Bearer (dsa_[^ ]*)$/i.exec(request.headers.authorization || '')
      if (!match) return (readOnly ? requireTenant : requireProcessing)(request, reply)
      const token = match[1]
      const client = isAccessToken(token) && store.resolveClientToken(credentialDigest(token))
      if (!client) return reply.code(401).header('WWW-Authenticate', 'Bearer error="invalid_token"').send({ message: 'The API access token is invalid or expired.' })
      if (!matchesClientTenant(client, request)) throw problem(403, 'This API client belongs to a different workspace.')
      if (!scopes.some((scope) => client.scopes.includes(scope))) {
        return reply.code(403).header('WWW-Authenticate', 'Bearer error="insufficient_scope"').send({ message: 'This API client does not have permission for the requested document operation.' })
      }
      request.subject = 'client:' + client.id
      request.accessToken = token
      request.clientScopes = client.scopes
      request.tenantId = client.tenantId
      request.tenantRole = 'operator'
      request.canProcess = !readOnly
    }
  }
  const documentAccess = (scope) => scopedDocumentAccess([scope], scope.endsWith(':read'))
  const templateEdit = scopedDocumentAccess(['templates:write', organizationTemplateEditScope], false)
  const documentDownload = scopedDocumentAccess(['documents:read', 'documents:generate', 'documents:convert'], true)
  async function recheckProcessing(request) {
    if (request.clientScopes) {
      const client = store.resolveClientToken(credentialDigest(request.accessToken))
      if (!client || client.tenantId !== request.tenantId || 'client:' + client.id !== request.subject) {
        throw problem(401, 'The API access token has expired or was revoked.')
      }
      return
    }
    const role = await resolveTenant(request.accessToken, request.tenantId, request.subject, request.organizationSlug)
    assertSessionActive(request.subject, request.accessToken)
    if (!processingRoles.has(role)) throw problem(403, 'Your tenant processing permission has changed.')
    request.tenantRole = role
  }
  return { requireIdentity, requireSignOutIdentity, requireTenant, requireProcessing, requireAdmin, documentAccess, documentDownload, templateEdit, recheckProcessing,
    assertSessionActive, endSession: request => store.endSession(sessionDigest(request.subject, request.accessToken)) }
}
