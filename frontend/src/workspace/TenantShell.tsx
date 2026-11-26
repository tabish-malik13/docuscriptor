import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Building2, LoaderCircle, LogOut, Plus } from 'lucide-react'
import { signOut, type Identity } from '../auth/supabase-auth'
import { requestWorkspaceLink } from '../auth/workspace-sign-in'
import { Brand } from '../shared/Brand'
import { reservedSlugs, suggestOrganizationSlug, validOrganizationSlug } from '../../../shared/organization-url.mjs'
import { api, WorkspaceRequestError } from './api'
import { roleLabels, TenantProvider, type Tenant } from './TenantContext'
import { currentOrganizationSlug, workspaceConfig, workspaceUrl } from './organization-location'
import { Workspace } from './Workspace'
import { features } from '../shared/features'
import './directory.css'

type Invitation = { id: string; tenant_id: string; tenant_name: string; email: string; role: string; expires_at: string }

export function WorkspaceAccessNotice({ error }: { error?: string }) {
  return <div className="account-directory">
    <header className="directory-masthead"><Brand /></header>
    <main className="directory-body">
      {error ? <section className="directory-unavailable"><h1>Workspace unavailable</h1>
        <p role="alert">{error}</p><a className="button primary" href={workspaceConfig.appOrigin}>Your organizations</a></section>
        : <p className="directory-status" role="status"><LoaderCircle size={17} className="spin" aria-hidden="true" />Opening your workspace…</p>}
    </main>
  </div>
}

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
  const heading = useRef<HTMLHeadingElement>(null)
  const loadVersion = useRef(0)
  const transition = useRef<Promise<string> | null>(null)
  const returningTo = new URLSearchParams(window.location.search).get('workspace')
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current
    try {
      const [memberships, pending] = await Promise.all([
        api('/api/organizations', {}, undefined, identity.id).then((response) => response.json()) as Promise<{ items: Tenant[] }>,
        currentOrganizationSlug || returningTo ? Promise.resolve({ items: [] }) : api('/api/invitations', {}, undefined, identity.id).then((response) => response.json()) as Promise<{ items: Invitation[] }>,
      ])
      if (version !== loadVersion.current) return
      setOrganizations(memberships.items); setInvitations(pending.items); setError('')
    } catch (cause) {
      if (version !== loadVersion.current) return
      if (cause instanceof WorkspaceRequestError && [401, 403].includes(cause.status)) {
        setOrganizations([]); setInvitations([])
      }
      setError(cause instanceof Error ? cause.message : 'Your organizations could not be loaded.')
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [returningTo, identity.id])
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
      return requestWorkspaceLink(identity.id, selected.id, challenge, state)
    })()
    void transition.current.then((url) => { if (active) { history.replaceState(null, '', '/'); window.location.replace(url) } }).catch((cause) => {
      if (!active) return
      transition.current = null
      setError(cause instanceof Error ? cause.message : 'The workspace could not be opened.')
    })
    return () => { active = false }
  }, [loading, error, returningTo, organizations, identity.id])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'The organization request failed.') }
    finally { setBusy(false) }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    if (reservedSlugs.has(slug)) { setError('This workspace address is reserved. Choose another address.'); return }
    if (!validOrganizationSlug(slug)) { setError('Choose a workspace address with 3–40 lowercase letters, numbers, or hyphens.'); return }
    void run(async () => {
      const created = await (await api('/api/organizations', { method: 'POST', body: JSON.stringify({ name: name.trim(), slug }) }, undefined, identity.id)).json() as Tenant
      window.location.assign(workspaceUrl(created.slug))
    })
  }
  if (currentOrganizationSlug) {
    if (loading) return <WorkspaceAccessNotice />
    if (!organization) return <WorkspaceAccessNotice error={error || 'This organization workspace is unavailable, or your account does not have access.'} />
    return <>{error && <div className="error-box" role="status">{error} <button className="button secondary" onClick={changed}>Retry</button></div>}
      <TenantProvider key={organization.id + ':' + organization.role} userId={identity.id} tenant={organization} onChange={changed}><Workspace identity={identity} /></TenantProvider></>
  }

  const firstOrganization = !loading && (creating || !error) && organizations.length === 0 && invitations.length === 0
  const showCreation = features.orgCreation && !returningTo && (creating || firstOrganization)
  return <div className="account-directory">
    <header className="directory-masthead"><Brand /><div className="directory-user"><span>{identity.name}</span>
      <button className="button secondary" disabled={busy} onClick={() => { void run(signOut) }}><LogOut size={15} aria-hidden="true" />Sign out</button></div></header>
    <main className="directory-body" aria-labelledby="directory-title">
      <div className="directory-heading"><div><h1 id="directory-title" ref={heading} tabIndex={-1}>Your organizations</h1>
        <p>{firstOrganization
          ? (features.orgCreation ? 'Create a workspace for your team’s documents.' : 'Ask an organization administrator to invite you to a workspace.')
          : 'Choose a workspace to open its documents and templates.'}</p></div>
        {features.orgCreation && !returningTo && !showCreation && <button className="button primary" disabled={busy || loading} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Create organization</button>}
      </div>
      {loading && <p className="directory-status" role="status"><LoaderCircle size={17} className="spin" aria-hidden="true" />Loading your organizations…</p>}
      {error && <div className="error-box directory-error" role="alert"><p>{error}</p><button className="button secondary" disabled={busy} onClick={changed}>Try again</button>
        {returningTo && <a className="button secondary" href={workspaceConfig.appOrigin}>Your organizations</a>}</div>}
      {returningTo && !error && !loading && <p className="directory-status" role="status"><LoaderCircle size={17} className="spin" aria-hidden="true" />Opening your organization workspace…</p>}
      {showCreation && <form className="directory-form" onSubmit={create}>
        <h2>Create organization</h2>
        <fieldset disabled={busy || loading}>
          <label className="field">Organization name<input name="name" required maxLength={120} autoFocus={creating} value={name}
            onChange={(event) => { setName(event.target.value); if (!customSlug) setSlug(suggestOrganizationSlug(event.target.value)) }} /></label>
          <label className="field">Workspace address<span className="directory-address">{workspaceConfig.routing === 'path' && <span>{workspaceConfig.appOrigin}/org/</span>}
            <input name="slug" aria-label="Workspace address" aria-describedby="directory-address-help" required minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" autoCapitalize="none" spellCheck={false}
              value={slug} onChange={(event) => { setSlug(event.target.value.toLowerCase()); setCustomSlug(true) }} />
            {workspaceConfig.routing === 'subdomain' && <span>.{workspaceConfig.baseDomain}</span>}</span></label>
          <p id="directory-address-help" className="directory-help">Choose 3–40 lowercase letters, numbers or hyphens. This address stays the same if you rename the organization.</p>
          <div className="directory-actions"><button className="button primary" type="submit">{busy ? 'Creating organization…' : 'Create organization'}</button>
            {!firstOrganization && <button type="button" className="button secondary" onClick={() => { setCreating(false); setError(''); heading.current?.focus() }}>Cancel</button>}</div>
        </fieldset>
      </form>}
      {!returningTo && organizations.length > 0 && <ul className="directory-list" aria-label="Organization workspaces">{organizations.map((entry) => <li key={entry.id}>
        <a className="directory-workspace" href={workspaceUrl(entry.slug)}>
          <span className="directory-glyph"><Building2 size={21} strokeWidth={1.65} aria-hidden="true" /></span>
          <span className="directory-workspace-name"><strong>{entry.name}</strong><small>{workspaceUrl(entry.slug).replace(/^https?:\/\//, '')}</small></span>
          <span className="directory-workspace-role">{roleLabels[entry.role]}</span><ArrowRight size={17} aria-hidden="true" />
        </a>
      </li>)}</ul>}
      {!returningTo && invitations.length > 0 && <section className="directory-invitations"><h2>Pending invitations</h2><p>Invitations sent to {identity.email}</p>
        <ul>{invitations.map((invitation) => <li key={invitation.id}><div><strong>{invitation.tenant_name}</strong><p>{invitation.role} · Expires {new Date(invitation.expires_at).toLocaleDateString()}</p></div>
          <button className="button secondary" disabled={busy} onClick={() => { void run(async () => {
            await api('/api/invitations/' + invitation.id + '/accept', { method: 'POST' }, undefined, identity.id); await refresh()
          }) }}>Accept invitation</button></li>)}</ul></section>}
    </main>
  </div>
}
