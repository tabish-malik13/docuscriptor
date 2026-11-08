import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Bell, ChevronRight, CircleHelp, FilePenLine, FileText,
  LogOut, Menu, Search, X,
} from 'lucide-react'
import { signOut, type Identity } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'
import { ActivityTable } from './ActivityTable'
import { DocumentWorkflow } from './DocumentWorkflow'
import { OverviewPage } from './OverviewPage'
import type { Activity } from './activity'
import { actions, readView, views, type View } from './navigation'
import { templates as starters, savedTemplate, type SavedTemplate, type Template } from './starter-templates'
import { roleLabels, useTenantApi } from './TenantContext'
import { TenantAccessPage } from './TenantAccessPage'
import { workspaceConfig } from './organization-location'
import { TemplatesPage } from './TemplatesPage'

type Dialog = 'search' | 'notifications' | 'new'

export function Workspace({ identity: user }: { identity: Identity }) {
  const { api, tenant, onChange: onTenantChange } = useTenantApi()
  const identity = { ...user, role: roleLabels[tenant.role], canProcess: tenant.role !== 'viewer' }
  const canAdmin = tenant.role === 'owner' || tenant.role === 'admin'
  const [view, setView] = useState(readView)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [query, setQuery] = useState('')
  const [sidebar, setSidebar] = useState(false)
  const [selected, setSelected] = useState<Template>()
  const [items, setItems] = useState<Activity[]>([])
  const [accountError, setAccountError] = useState('')
  const [dataError, setDataError] = useState('')
  const [templates, setTemplates] = useState<Template[]>(starters)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingData, setLoadingData] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const refreshVersion = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    setLoadingData(true)
    try {
      const [jobs, saved] = await Promise.all([
        api('/api/jobs').then((response) => response.json()) as Promise<{ items: Activity[]; nextOffset: number | null }>,
        api('/api/templates').then((response) => response.json()) as Promise<{ items: SavedTemplate[] }>,
      ])
      if (version !== refreshVersion.current) return
      setItems(jobs.items); setNextOffset(jobs.nextOffset)
      setTemplates([...starters, ...saved.items.map(savedTemplate)])
      setDataError('')
    } catch (cause) {
      if (version === refreshVersion.current) setDataError(cause instanceof Error ? cause.message : 'Saved workspace data could not be loaded.')
    } finally { if (version === refreshVersion.current) setLoadingData(false) }
  }, [api])
  const onDataChange = useCallback(() => { void refresh() }, [refresh])
  useEffect(() => { void refresh(); return () => { refreshVersion.current++ } }, [refresh])
  const hasProcessingJobs = items.some((item) => item.status === 'processing')
  useEffect(() => {
    if (!hasProcessingJobs) return
    const interval = window.setInterval(onDataChange, 5000)
    return () => window.clearInterval(interval)
  }, [hasProcessingJobs, onDataChange])
  async function loadMore() {
    if (nextOffset === null || loadingMore) return
    const version = refreshVersion.current
    setLoadingMore(true)
    try {
      const result = await (await api('/api/jobs?offset=' + nextOffset)).json() as { items: Activity[]; nextOffset: number | null }
      if (version !== refreshVersion.current) return
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((entry) => entry.id === item.id))])
      setNextOffset(result.nextOffset); setDataError('')
    } catch (cause) { setDataError(cause instanceof Error ? cause.message : 'More jobs could not be loaded.') }
    finally { setLoadingMore(false) }
  }
  const dialogRef = useRef<HTMLDialogElement>(null)
  const initials = identity.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  useEffect(() => {
    const onHash = () => setView(readView())
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuery('')
        setDialog('search')
      }
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const element = dialogRef.current
    if (dialog && !element?.open) element?.showModal()
    if (!dialog && element?.open) element.close()
  }, [dialog])

  function go(next: View, template?: Template) {
    setSelected(template)
    setView(next)
    setSidebar(false)
    setDialog(null)
    if (readView() !== next) window.location.hash = next
    window.scrollTo(0, 0)
  }

  function nav(next: View) {
    const Icon = views[next].icon
    return <button className={'nav-item' + (view === next ? ' active' : '')} aria-current={view === next ? 'page' : undefined} key={next} onClick={() => go(next)}>
      <Icon size={18} strokeWidth={1.8} /><span>{views[next].title}</span>
    </button>
  }

  const matches = (Object.keys(views) as View[]).filter((entry) => views[entry].title.toLowerCase().includes(query.trim().toLowerCase()))
  const descriptions = {
    generate: 'Combine a Word template with runtime values to create an editable document.',
    convert: 'Turn Word documents and HTML files into shareable PDFs.',
    templates: 'Choose a starter layout and make it your own with runtime values.',
    activity: 'Review saved documents and processing history for your account.',
    account: 'Review your identity and the permissions assigned to your organization membership.',
    team: 'Manage organization members, invitations, ownership, and access history.',
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      {sidebar && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
      <aside id="workspace-navigation" className={'sidebar' + (sidebar ? ' open' : '')}>
        <button className="brand-link" aria-label="DocuScripter overview" onClick={() => go('overview')}><Brand /></button>
        <div className="workspace-card">
          <span className="workspace-mark">D</span><div><strong>{tenant.name}</strong><small>Organization workspace</small></div>
        </div>
        <nav aria-label="Workspace navigation">
          <div className="nav-group"><span className="label">WORKSPACE</span>
            {(['overview', 'generate', 'convert'] as const).map(nav)}
            <a className="nav-item" href="/editor.html" target="_blank" rel="noopener"><FilePenLine size={18} strokeWidth={1.8} /> DOCX editor <span className="sr-only">(opens in a new tab)</span></a>
          </div>
          <div className="nav-group"><span className="label">LIBRARY</span>{(['templates', 'activity'] as const).map(nav)}{canAdmin && nav('team')}</div>
        </nav>
        <div className="sidebar-bottom">
          <a className="nav-item" href={workspaceConfig.appOrigin}>Your organizations</a>
          <button className="nav-item help-link" onClick={() => go('account')}><CircleHelp size={18} strokeWidth={1.8} /> Workspace access</button>
          <button className="account-chip" onClick={() => go('account')}><span className="avatar">{initials}</span>
            <span><strong>{identity.name}</strong><small>{identity.role}</small></span><ChevronRight size={15} className="account-chevron" />
          </button>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" aria-expanded={sidebar} aria-controls="workspace-navigation" onClick={() => setSidebar(!sidebar)}><Menu size={22} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{views[view].title}</strong></div>
          <div className="top-actions">
            <button className="search-button" aria-label="Search workspace" onClick={() => { setQuery(''); setDialog('search') }}><Search size={17} /><span>Search workspace</span><kbd>⌘ K</kbd></button>
            <button className="icon-button bell" aria-label="Notifications" onClick={() => setDialog('notifications')}><Bell size={19} />{items.length > 0 && <i />}</button>
            <span className="header-divider" />
            <button className="avatar header-avatar" aria-label="Account and access" onClick={() => go('account')}>{initials}</button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="main-content">
          {dataError && <div className="error-box" role="alert">{dataError} <button className="button secondary" disabled={loadingData} onClick={onDataChange}>Retry</button></div>}
          {loadingData && <p className="form-note" role="status">Loading saved workspace data…</p>}
          {view === 'overview' ? <OverviewPage items={items} navigate={go} openNewDocument={() => setDialog('new')} /> : <>
            <button className="back-link" onClick={() => go('overview')}><ArrowLeft size={16} /> Overview</button>
            <div className="page-heading detail-heading"><div><h1>{views[view].title}</h1><p>{descriptions[view]}</p></div></div>
            {view === 'generate' && <DocumentWorkflow key={selected?.id || 'upload'} kind="DOCX" identity={identity} selected={selected} templates={templates} onComplete={onDataChange} />}
            {view === 'convert' && <DocumentWorkflow kind="PDF" identity={identity} templates={templates} onComplete={onDataChange} />}
            {view === 'activity' && <>
              <div className="section-heading"><span>{items.length} jobs loaded</span><button className="button secondary" disabled={loadingData} onClick={onDataChange}>Refresh</button></div>
              <div className="panel"><ActivityTable items={items} onChange={identity.canProcess ? onDataChange : undefined} currentUserId={identity.id} /></div>
              {nextOffset !== null && <button className="button secondary load-more" disabled={loadingMore || loadingData} onClick={() => { void loadMore() }}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
            </>}
            {view === 'templates' && <TemplatesPage templates={templates} currentUserId={identity.id} canProcess={identity.canProcess} onSelect={(template) => go('generate', template)} onChange={onDataChange} />}
            {view === 'team' && (canAdmin ? <TenantAccessPage /> : <p className="form-note">Organization administrator access is required.</p>)}
            {view === 'account' && <section className="panel account-panel">
              <div className="form-heading"><span className="avatar">{initials}</span><div><h2>{identity.name}</h2><p>{identity.email || 'Workspace account'}</p></div></div>
              <dl><dt>Organization</dt><dd>{tenant.name}</dd><dt>Organization role</dt><dd>{identity.role}</dd><dt>Document processing</dt><dd>{identity.canProcess ? 'Allowed' : 'View only'}</dd><dt>Identity provider</dt><dd>Supabase Auth</dd></dl>
              {accountError && <p className="error-box" role="alert">{accountError}</p>}
              <button className="button secondary" onClick={() => {
                if (window.confirm('Leave this organization? You will lose access to its documents and templates.')) {
                  void api('/api/tenant/leave', { method: 'POST' }).then(onTenantChange).catch((cause) => setAccountError(cause instanceof Error ? cause.message : 'Could not leave the organization.'))
                }
              }}>Leave organization</button>
              <button className="button secondary" onClick={() => { void signOut().catch(() => setAccountError('Sign-out failed. Please try again.')) }}><LogOut size={17} /> Sign out</button>
            </section>}
          </>}
          <footer className="workspace-footer"><span>DocuScripter</span></footer>
        </main>
      </div>

      <dialog ref={dialogRef} className="dialog" aria-labelledby="dialog-title" onClose={() => setDialog(null)} onClick={(event) => { if (event.target === event.currentTarget) setDialog(null) }}>
        {dialog && <div className="dialog-body">
          <div className="dialog-heading"><h2 id="dialog-title">{dialog === 'search' ? 'Search workspace' : dialog === 'new' ? 'New document' : 'Notifications'}</h2>
            <button className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={19} /></button></div>
          {dialog === 'search' && <><label className="dialog-search"><Search size={18} /><input aria-label="Search pages" placeholder="Find a workspace page…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></label>
            <div className="dialog-list">{matches.length ? matches.map((entry) => { const Icon = views[entry].icon; return <button key={entry} onClick={() => go(entry)}><Icon size={18} /> {views[entry].title}<ChevronRight size={16} /></button> }) : <p>No matching pages.</p>}</div></>}
          {dialog === 'new' && <div className="dialog-list">{actions.map(({ view: target, title, icon: Icon }) => <button key={target} onClick={() => go(target)}><Icon size={19} /> {title}<ChevronRight size={16} /></button>)}</div>}
          {dialog === 'notifications' && <div className="dialog-list">{items.length
            ? items.slice(0, 4).map((item) => <button key={item.id} onClick={() => go('activity')}><FileText size={18} /> {item.name}: {item.status === 'ready' ? 'ready' : item.status === 'failed' ? 'failed' : 'processing'} <ChevronRight size={16} /></button>)
            : <p>You’re all caught up.</p>}</div>}
        </div>}
      </dialog>
    </div>
  )
}
