import { currentOrganizationSlug, workspaceConfig } from '../workspace/organization-location'
import { installWorkspaceSession } from './supabase-auth'

const pendingKey = 'docuscripter.workspace-sign-in'
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
let exchange: Promise<void> | null = null

export async function startWorkspaceSignIn() {
  if (!currentOrganizationSlug) return
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const state = crypto.randomUUID()
  sessionStorage.setItem(pendingKey, JSON.stringify({ state, verifier, slug: currentOrganizationSlug, expires: Date.now() + 5 * 60_000 }))
  const url = new URL(workspaceConfig.appOrigin)
  url.search = new URLSearchParams({ workspace: currentOrganizationSlug, state, challenge }).toString()
  window.location.replace(url.href)
}

export function finishWorkspaceSignIn() {
  if (workspaceConfig.routing === 'path') return Promise.resolve()
  const params = new URLSearchParams(window.location.hash.slice(1))
  const code = params.get('workspace-code')
  if (!code) return Promise.resolve()
  if (exchange) return exchange
  exchange = (async () => {
    const raw = sessionStorage.getItem(pendingKey)
    const pending = raw ? JSON.parse(raw) as { state: string; verifier: string; slug: string; expires: number } : null
    if (!pending || pending.expires <= Date.now() || pending.slug !== currentOrganizationSlug || pending.state !== params.get('state')) {
      throw new Error('This workspace sign-in has expired. Return to your organizations and try again.')
    }
    // Same-origin exchange: no access or refresh token is placed in a URL.
    const response = await fetch('/api/auth/workspace-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier: pending.verifier }), signal: AbortSignal.timeout(10_000),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.message || 'Workspace sign-in could not be completed.')
    await installWorkspaceSession(result)
    sessionStorage.removeItem(pendingKey)
    history.replaceState(null, '', '/')
  })()
  return exchange
}

