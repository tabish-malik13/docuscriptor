import { useEffect, useState } from 'react'
import { SignInPage } from '../auth/SignInPage'
import { authConfigured, finishDirectorySignOut, watchIdentity, type Identity } from '../auth/supabase-auth'
import { finishWorkspaceSignIn, startWorkspaceSignIn } from '../auth/workspace-sign-in'
import { currentOrganizationSlug, organizationAddressError, workspaceConfig } from './organization-location'
import { OrganizationShell, WorkspaceAccessNotice } from './TenantShell'

export function WorkspaceApp() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(authConfigured)
  const [error, setError] = useState('')
  const [logoutNotice, setLogoutNotice] = useState('')

  useEffect(() => {
    if (organizationAddressError) return
    let active = true
    let unwatch: (() => void) | undefined
    async function initialize() {
      const notice = await finishDirectorySignOut()
      await finishWorkspaceSignIn()
      if (!active) return
      setLogoutNotice(notice)
      unwatch = watchIdentity((user, initial) => {
        if (!active) return
        if (authConfigured && initial && !user && currentOrganizationSlug && workspaceConfig.routing === 'subdomain') {
          void startWorkspaceSignIn().catch(reportError)
          return
        }
        setError('')
        setIdentity(user); setLoading(false)
      }, reportError, () => { setIdentity(null); setLoading(true) })
    }
    function reportError(cause: unknown) {
      if (!active) return
      setError(cause instanceof Error ? cause.message : 'Your session could not be verified.')
      setLoading(false)
    }
    void initialize().catch(reportError)
    return () => { active = false; unwatch?.() }
  }, [])

  if (organizationAddressError) return <WorkspaceAccessNotice error={organizationAddressError} />
  if (!identity && error && currentOrganizationSlug && workspaceConfig.routing === 'subdomain') return <WorkspaceAccessNotice error={error} />
  return identity ? <>{logoutNotice && <p className="error-box" role="status">{logoutNotice}</p>}
    <OrganizationShell key={identity.id} identity={identity} /></> : <SignInPage loading={loading}
    sessionError={error || logoutNotice ? { message: error || logoutNotice, returnUrl: workspaceConfig.appOrigin } : undefined}
    onSignIn={user => { setLogoutNotice(''); setIdentity(user) }} />
}
