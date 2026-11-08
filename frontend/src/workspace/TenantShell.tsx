import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Building2, LogOut, Plus } from 'lucide-react'
import { signOut, sessionTokens, type Identity } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'
import { suggestOrganizationSlug, validOrganizationSlug } from '../../../shared/organization-url.mjs'
import { api } from './api'
import { TenantProvider, type Tenant } from './TenantContext'
import { currentOrganizationSlug, workspaceConfig, workspaceUrl } from './organization-location'
import { Workspace } from './Workspace'

type Invitation = { id: string; tenant_id: string; tenant_name: string; email: string; role: string; expires_at: string }

export function OrganizationShell({ identity }: { identity: Identity }) {
  const [organizations, setOrganizations] = useState<Tenant[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [customSlug, setCustomSlug] = useState(false)
  const loadVersion = useRef(0)
  const transition = useRef<Promise<string> | null>(null)
  const returningTo = new URLSearchParams(window.location.search).get('workspace')
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current
    try {
      const [memberships, pending] = await Promise.all([
        api('/api/organizations').then((response) => response.json()) as Promise<{ items: Tenant[] }>,
        currentOrganizationSlug ? Promise.resolve({ items: [] }) : api('/api/invitations').then((response) => response.json()) as Promise<{ items: Invitation[] }>,
      ])
      if (version !== loadVersion.current) return
      setOrganizations(memberships.items); setInvitations(pending.items); setError('')
    } catch (cause) {
      if (version !== loadVersion.current) return
      setOrganizations([]); setInvitations([])
      setError(cause instanceof Error ? cause.message : 'Your organizations could not be loaded.')
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const check = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', check)
    const timer = window.setInterval(check, 60_000)
    return () => { loadVersion.current++; window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [refresh])
  const changed = useCallback(() => { void refresh() }, [refresh])
  const organization = organizations.find((entry) => entry.slug === currentOrganizationSlug)

  useEffect(() => {
    if (loading || error || currentOrganizationSlug || !returningTo) return
    let active = true
    if (!transition.current) transition.current = (async () => {
      const selected = organizations.find((entry) => entry.slug === returningTo)
      const params = new URLSearchParams(window.location.search)
      const challenge = params.get('challenge'), state = params.get('state')
      if (!selected || !challenge || !state) throw new Error('You do not have access to this organization workspace.')
      const result = await (await api('/api/auth/workspace-link', {
        method: 'POST', body: JSON.stringify({ organizationId: selected.id, challenge, state, ...await sessionTokens() }),
      })).json() as { url: string }
      return result.url
    })()
    void transition.current.then((url) => { if (active) { history.replaceState(null, '', '/'); window.location.replace(url) } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'The workspace could not be opened.') })
    return () => { active = false }
  }, [loading, error, returningTo, organizations])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The organization request failed.') }
    finally { setBusy(false) }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validOrganizationSlug(slug)) { setError('Choose a workspace address with 3–40 lowercase letters, numbers, or hyphens.'); return }
    void run(async () => {
      const created = await (await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name: name.trim(), slug }) })).json() as Tenant
      window.location.assign(workspaceUrl(created.slug))
    })
  }
  if (currentOrganizationSlug) {
    if (loading) return <div className="organization-directory"><Brand /><p role="status">Opening your workspace…</p></div>
    if (!organization || error) return <div className="organization-directory"><Brand /><section className="panel workflow-form"><h1>Workspace unavailable</h1><p role="alert">{error || 'This organization workspace is unavailable, or your account does not have access.'}</p><a className="button primary" href={workspaceConfig.appOrigin}>Your organizations</a></section></div>
    return <TenantProvider tenant={organization} onChange={changed}><Workspace key={organization.id + ':' + organization.role} identity={identity} /></TenantProvider>
  }
  return <div className="organization-directory">
    <header className="directory-header"><Brand /><div><span>{identity.name}</span><button className="button secondary" disabled={busy} onClick={() => { void run(signOut) }}><LogOut size={16} /> Sign out</button></div></header>
    <div className="page-heading"><div><span className="label">YOUR WORKSPACES</span><h1>Your organizations</h1><p>Open your organization’s workspace to create, edit, and share documents.</p></div>
      {!returningTo && <button className="button primary" disabled={busy || loading} onClick={() => setCreating(!creating)}><Plus size={17} /> Create organization</button>}
    </div>
    {loading && <p role="status">Loading your organizations…</p>}
    {error && <div className="error-box" role="alert">{error}<button className="button secondary" disabled={busy} onClick={changed}>Try again</button></div>}
    {returningTo && !error && <p role="status">Opening your organization workspace…</p>}
    {!returningTo && (creating || (!loading && !error && organizations.length === 0 && invitations.length === 0)) && <form className="panel workflow-form organization-create" onSubmit={create}>
      <h2>Create your organization</h2><p className="form-note">Give your team its own workspace address. Only members you invite can access its documents.</p>
      <fieldset disabled={busy || loading}>
        <label className="field">Organization name<input name="name" required maxLength={120} value={name} onChange={(event) => { setName(event.target.value); if (!customSlug) setSlug(suggestOrganizationSlug(event.target.value)) }} /></label>
        <label className="field">Workspace address<div className="workspace-address"><input name="slug" aria-label="Workspace address" required minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" value={slug} onChange={(event) => { setSlug(event.target.value.toLowerCase()); setCustomSlug(true) }} /><span>.{workspaceConfig.baseDomain}</span></div></label>
        <p className="form-note">Your address stays the same if you rename your organization.</p>
        <button className="button primary" type="submit">{busy ? 'Creating organization…' : 'Create organization'}</button>
      </fieldset>
    </form>}
    {!returningTo && <div className="organization-grid">{organizations.map((entry) => <a className="panel organization-card" href={workspaceUrl(entry.slug)} key={entry.id}>
      <span className="icon-chip violet"><Building2 size={23} /></span><h2>{entry.name}</h2><p>{new URL(workspaceUrl(entry.slug)).host}</p><span className="organization-open">Open workspace <ArrowRight size={16} /></span>
    </a>)}</div>}
    {!returningTo && invitations.length > 0 && <section className="panel workflow-form"><h2>Invitations for {identity.email}</h2>
      {invitations.map((invitation) => <div className="tenant-invitation" key={invitation.id}><div><strong>{invitation.tenant_name}</strong><p>{invitation.role} · Expires {new Date(invitation.expires_at).toLocaleDateString()}</p></div>
        <button className="button primary" disabled={busy} onClick={() => { void run(async () => {
          await api('/api/invitations/' + invitation.id + '/accept', { method: 'POST' }); await refresh()
        }) }}>Accept invitation</button>
      </div>)}
    </section>}
  </div>
}
