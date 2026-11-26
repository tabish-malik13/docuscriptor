import { createClient, type Session, type User } from '@supabase/supabase-js'
import { workspaceConfig } from '../workspace/organization-location'
import { features } from '../shared/features'

export type Identity = { id: string; name: string; email: string }
export type WorkspaceIdentity = Identity & { role: string; canProcess: boolean }

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
let auth: ReturnType<typeof createClient>['auth'] | null = null
export let authConfigured = false

export function initializeAuth() {
  if (features.auth && url && key && !auth) {
    auth = createClient(url, key, { auth: { detectSessionInUrl: true, flowType: 'pkce' } }).auth
    authConfigured = true
  }
}

function readIdentity(user: User): Identity | null {
  if (user.is_anonymous || user.aud !== 'authenticated' || !user.email_confirmed_at) return null
  const name = user.user_metadata?.full_name
  return {
    id: user.id,
    name: (typeof name === 'string' && name.trim()) || user.email || 'Workspace member',
    email: user.email || '',
  }
}

const sessionEvent = 'docuscripter-check-session'
let verifiedFingerprint: string | undefined
export function recheckBrowserSession() { window.dispatchEvent(new Event(sessionEvent)) }

async function verifySession(session: Session, signal: AbortSignal): Promise<Identity | null> {
  const result = await fetch('/api/auth/session', { headers: { Authorization: 'Bearer ' + session.access_token },
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
  if (result.status === 401 || result.status === 403) {
    // An older request must never clear a newer login from another tab.
    if (!signal.aborted && (await auth?.getSession())?.data.session?.access_token === session.access_token) {
      void auth?.signOut({ scope: 'local' }).catch(() => {})
    }
    return null
  }
  if (!result.ok) throw new Error('Your session could not be verified. Try again.')
  const identity: Identity = await result.json()
  if (identity.id !== session.user.id) throw new Error('Your signed-in account has changed.')
  return identity
}

// Each tenant origin has its own SDK storage. Verify against the shared gateway
// when a page is restored or focused, and while a signed-in tab remains visible.
export function watchIdentity(change: (identity: Identity | null, initial: boolean) => void,
  failed: (cause: unknown) => void, restoring?: () => void) {
  if (!auth) { change(null, true); return () => {} }
  const client = auth
  let first = true, closed = false, user: string | null = null, observedToken: string | null = null
  let timer: number | undefined, pending: AbortController | undefined
  function publish(identity: Identity | null) {
    user = identity?.id ?? null
    const initial = first
    first = false
    change(identity, initial)
  }
  function cancel() { clearTimeout(timer); pending?.abort(); pending = undefined }
  function check() {
    if (closed || pending) return
    const controller = new AbortController()
    pending = controller
    // Run outside the Supabase auth-state callback to avoid re-entering its session lock.
    timer = window.setTimeout(async () => {
      try {
        const { data, error } = await client.getSession()
        if (controller.signal.aborted) return
        if (error) throw error
        const identity = data.session ? await verifySession(data.session, controller.signal) : null
        const marker = identity && data.session ? await sessionFingerprint(data.session) : undefined
        if (!controller.signal.aborted) { verifiedFingerprint = marker; publish(identity) }
      } catch (cause) { if (!controller.signal.aborted) failed(cause) }
      finally { if (pending === controller) pending = undefined }
    }, 20)
  }
  const subscription = client.onAuthStateChange((event, session) => {
    if (closed) return
    if (!session || event === 'SIGNED_OUT') { cancel(); observedToken = null; publish(null); return }
    if (user && user !== session.user.id) { cancel(); verifiedFingerprint = undefined; publish(null) }
    if (session.access_token === observedToken && event === 'SIGNED_IN') return
    if (session.access_token !== observedToken) cancel()
    observedToken = session.access_token
    check()
  }).data.subscription
  const visible = () => { if (document.visibilityState === 'visible') check() }
  const restored = (e: PageTransitionEvent) => { if (e.persisted) { restoring?.(); check() } }
  window.addEventListener('focus', visible)
  window.addEventListener('pageshow', restored)
  const denied = () => { cancel(); check() }
  window.addEventListener(sessionEvent, denied)
  document.addEventListener('visibilitychange', visible)
  const interval = window.setInterval(() => { if (user || observedToken) visible() }, 30_000)
  return () => {
    closed = true; cancel(); subscription.unsubscribe(); clearInterval(interval)
    window.removeEventListener('focus', visible); window.removeEventListener('pageshow', restored)
    window.removeEventListener(sessionEvent, denied); document.removeEventListener('visibilitychange', visible)
  }
}

export async function accessToken(expectedUserId?: string) {
  const result = await auth?.getSession()
  if (!result?.data.session || result.error) throw new Error('Sign in to process documents.')
  if (expectedUserId && result.data.session.user.id !== expectedUserId) throw new Error('Your signed-in account has changed.')
  return result.data.session.access_token
}

export function watchSessionUser(onChange: (userId: string | null) => void) {
  let verified = false
  return watchIdentity(identity => { verified = !!identity; onChange(identity?.id ?? null) }, () => {
    // Losing connectivity while editing must preserve the open document. API
    // requests still verify the session, and a definite sign-out clears the library.
    if (!verified) onChange(null)
  })
}

export async function signIn(email: string, password: string) {
  if (!auth) throw new Error('Supabase Auth is not configured.')
  const { data, error } = await auth.signInWithPassword({ email, password })
  if (error) throw error
  const identity = readIdentity(data.user)
  if (!identity) {
    await auth.signOut({ scope: 'local' })
    throw new Error('This account cannot access the workspace.')
  }
  return identity
}

async function sessionFingerprint(session: Session) {
  let id = session.access_token
  try {
    const payload = session.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')
    const claims = JSON.parse(atob(payload))
    if (claims.sub === session.user.id && typeof claims.session_id === 'string' && /^[a-f0-9-]{36}$/i.test(claims.session_id)) id = claims.session_id
  } catch { /* Older sessions use an exact access-token fingerprint. */ }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([session.user.id, id])))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function revokeWorkspaceSession(token: string) {
  try {
    const response = await fetch('/api/auth/sign-out', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) })
    return response.ok
  } catch { return false }
}

export async function signOut() {
  if (!auth) return
  const { data: { session }, error } = await auth.getSession()
  const target = new URL(workspaceConfig.appOrigin)
  if (session) {
    const marker = await sessionFingerprint(session)
    const confirmed = await revokeWorkspaceSession(session.access_token)
    target.hash = new URLSearchParams({ 'signed-out': marker, ...(confirmed ? {} : { incomplete: '1' }) }).toString()
    const current = (await auth.getSession()).data.session
    if (current && await sessionFingerprint(current) !== marker) return
  } else if (error) target.hash = new URLSearchParams({ 'signed-out': verifiedFingerprint ?? 'unknown', incomplete: '1' }).toString()
  // The SDK removes the local session even if the provider's revocation request fails.
  await auth.signOut({ scope: 'local' }).catch(() => {})
  sessionStorage.removeItem('docuscripter.workspace-sign-in')
  window.location.replace(target.href)
}

export async function finishDirectorySignOut() {
  if (window.location.origin !== workspaceConfig.appOrigin) return ''
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const marker = fragment.get('signed-out')
  let incomplete = fragment.get('incomplete') === '1'
  if (!marker || (!/^[a-f0-9]{64}$/.test(marker) && !(incomplete && marker === 'unknown'))) return ''
  history.replaceState(null, '', window.location.pathname)
  const session = (await auth?.getSession())?.data.session
  // A directory tab may belong to a different, newer session of the same person.
  if (session && await sessionFingerprint(session) === marker) {
    if (incomplete) incomplete = !await revokeWorkspaceSession(session.access_token)
    await auth?.signOut({ scope: 'local' }).catch(() => {})
  }
  return incomplete ? 'The gateway could not confirm sign-out across all workspaces.' : ''
}

export async function register(email: string, password: string) {
  if (!auth) throw new Error('Supabase Auth is not configured.')
  const { error } = await auth.signUp({ email, password })
  if (error) throw error
}

export async function sessionTokens(expectedUser: string) {
  const result = await auth?.getSession()
  if (!result?.data.session || result.error) throw new Error('Sign in to open your organization workspace.')
  if (result.data.session.user.id !== expectedUser) throw new Error('Your signed-in account has changed.')
  return { accessToken: result.data.session.access_token, refreshToken: result.data.session.refresh_token }
}

export async function installWorkspaceSession(session: { access_token: string; refresh_token: string; userId: string }) {
  if (!auth) throw new Error('Authentication is not configured.')
  const { data, error } = await auth.setSession(session)
  if (error) throw error
  if (!data.user || data.user.id !== session.userId) {
    await auth.signOut({ scope: 'local' })
    throw new Error('The workspace sign-in identity could not be verified.')
  }
}
