const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const userEndpoint = supabaseUrl ? new URL('/auth/v1/user', supabaseUrl) : null
if (publishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
  throw new Error('SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key.')
}
const operations = new Set(['workspace-admin', 'document-operator'])

export async function authorizeDocumentProcessing(request, reply) {
  const [scheme, token, extra] = (request.headers.authorization || '').split(' ')
  if (scheme !== 'Bearer' || !token || extra !== undefined || token.length > 8192) {
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ message: 'Sign in to continue.' })
  }
  if (!userEndpoint || !publishableKey) {
    return reply.code(503).send({ message: 'Supabase Auth has not been configured.' })
  }

  let user
  try {
    const response = await fetch(userEndpoint, {
      headers: { apikey: publishableKey, Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
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

  if (!user || user.is_anonymous || user.aud !== 'authenticated' || typeof user.id !== 'string' ||
    !user.id || !operations.has(user.app_metadata?.workspace_role)) {
    return reply.code(403).send({ message: 'Your workspace role cannot process documents.' })
  }
  request.subject = user.id
}
