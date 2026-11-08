import { useEffect, useState } from 'react'
import { SignInPage } from '../auth/SignInPage'
import { authConfigured, currentIdentity, watchSignOut, type Identity } from '../auth/supabase-auth'
import { finishWorkspaceSignIn, startWorkspaceSignIn } from '../auth/workspace-sign-in'
import { currentOrganizationSlug, organizationAddressError, workspaceConfig } from './organization-location'
import { OrganizationShell } from './TenantShell'

export function WorkspaceApp() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(authConfigured)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (organizationAddressError) return
    let active = true
    const unwatch = watchSignOut(() => setIdentity(null))
    finishWorkspaceSignIn().then(currentIdentity).then(
      async (user) => {
        if (!active) return
        if (!user && currentOrganizationSlug && workspaceConfig.routing === 'subdomain') await startWorkspaceSignIn()
        else setIdentity(user)
      },
    ).catch((cause) => { if (active) { setUnavailable(true); setError(cause instanceof Error ? cause.message : 'Sign-in is unavailable.') } }
    ).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unwatch() }
  }, [])

  if (organizationAddressError) return <main className="organization-directory"><h1>Workspace unavailable</h1><p role="alert">{organizationAddressError}</p><a href={workspaceConfig.appOrigin}>Your organizations</a></main>
  return identity ? <OrganizationShell key={identity.id} identity={identity} /> : <><SignInPage loading={loading} unavailable={unavailable} onSignIn={setIdentity} />{error && <div className="workspace-auth-error" role="alert"><p>{error}</p><a className="button secondary" href={workspaceConfig.appOrigin}>Return to organizations</a></div>}</>
}
