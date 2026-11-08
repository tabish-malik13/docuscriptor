import { useEffect, useState } from 'react'
import { SignInPage } from '../auth/SignInPage'
import { authConfigured, currentIdentity, watchSignOut, type Identity } from '../auth/supabase-auth'
import { Workspace } from './Workspace'

export function WorkspaceApp() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(authConfigured)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let active = true
    const unwatch = watchSignOut(() => setIdentity(null))
    currentIdentity().then(
      (user) => { if (active) setIdentity(user) },
      () => { if (active) setUnavailable(true) },
    ).finally(() => { if (active) setLoading(false) })
    return () => { active = false; unwatch() }
  }, [])

  return identity ? <Workspace identity={identity} /> : <SignInPage loading={loading} unavailable={unavailable} onSignIn={setIdentity} />
}
