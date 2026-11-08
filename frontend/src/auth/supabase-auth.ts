import { createClient, type User } from '@supabase/supabase-js'

export type Identity = { id: string; name: string; email: string }
export type WorkspaceIdentity = Identity & { role: string; canProcess: boolean }

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const auth = url && key ? createClient(url, key, { auth: { detectSessionInUrl: true, flowType: 'pkce' } }).auth : null
export const authConfigured = auth !== null

function readIdentity(user: User): Identity | null {
  if (user.is_anonymous || user.aud !== 'authenticated' || !user.email_confirmed_at) return null
  const name = user.user_metadata?.full_name
  return {
    id: user.id,
    name: (typeof name === 'string' && name.trim()) || user.email || 'Workspace member',
    email: user.email || '',
  }
}

export async function currentIdentity(): Promise<Identity | null> {
  if (!auth) return null
  const { data: { session }, error: sessionError } = await auth.getSession()
  if (sessionError) throw sessionError
  if (!session) return null
  const { data, error } = await auth.getUser()
  if (error?.status === 401 || error?.status === 403) return null
  if (error) throw error
  return data.user ? readIdentity(data.user) : null
}

export async function accessToken() {
  const result = await auth?.getSession()
  if (!result?.data.session || result.error) throw new Error('Sign in to process documents.')
  return result.data.session.access_token
}

export async function signIn(email: string, password: string) {
  if (!auth) throw new Error('Supabase Auth is not configured.')
  const { data, error } = await auth.signInWithPassword({ email, password })
  if (error) throw error
  const identity = readIdentity(data.user)
  if (!identity) {
    await signOut()
    throw new Error('This account cannot access the workspace.')
  }
  return identity
}

export async function signOut() {
  const result = await auth?.signOut({ scope: 'local' })
  if (result?.error) throw result.error
}

export async function register(email: string, password: string) {
  if (!auth) throw new Error('Supabase Auth is not configured.')
  const { error } = await auth.signUp({ email, password })
  if (error) throw error
}

export function watchSignOut(onSignOut: () => void) {
  const subscription = auth?.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') onSignOut()
  }).data.subscription
  return () => subscription?.unsubscribe()
}

export async function sessionTokens() {
  const result = await auth?.getSession()
  if (!result?.data.session || result.error) throw new Error('Sign in to open your organization workspace.')
  return { refreshToken: result.data.session.refresh_token }
}

export async function installWorkspaceSession(session: { access_token: string; refresh_token: string; userId: string }) {
  if (!auth) throw new Error('Authentication is not configured.')
  const { data, error } = await auth.setSession(session)
  if (error) throw error
  if (!data.user || data.user.id !== session.userId) {
    await signOut()
    throw new Error('The workspace sign-in identity could not be verified.')
  }
}
