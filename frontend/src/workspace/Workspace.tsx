import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight, Bell, Building2, Check, ChevronRight, ChevronsUpDown, FilePenLine, FileText,
  LogOut, Menu, Search, X,
} from 'lucide-react'
import { signOut, type Identity } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'
import { ActivityTable } from './ActivityTable'
import { BatchPage } from './BatchPage'
import { BillingPage } from './BillingPage'
import { DocumentWorkflow } from './DocumentWorkflow'
import { OverviewPage } from './OverviewPage'
import type { Activity } from './activity'
import { documentActions, readView, viewEnabled, views, type View } from './navigation'
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
  // Workspace remounts on account or organization change. Store only IDs on this device.
  const pinKey = 'docuscripter.templatePins.' + user.id + '.' + tenant.id
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(pinKey) || '[]')
      return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []
    } catch { return [] }
  })
  function togglePin(id: string) {
    const updated = pinnedIds.includes(id) ? pinnedIds.filter(pin => pin !== id) : [...pinnedIds, id]
    setPinnedIds(updated)
    try { localStorage.setItem(pinKey, JSON.stringify(updated)) } catch { /* Pins remain usable during this session. */ }
  }
  const [items, setItems] = useState<Activity[]>([])
  const [accountError, setAccountError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
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
  const searchInput = useRef<HTMLInputElement>(null)
  const mobileNav = useRef<HTMLDialogElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const previousView = useRef(view)
  const shortcut = /Mac|iPad|iPhone/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
  const initials = identity.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()

  useEffect(() => {
    const onHash = () => { setView(readView()); setSidebar(false); setDialog(null) }
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSidebar(false)
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
    const drawer = mobileNav.current
    if (sidebar && !drawer?.open) drawer?.showModal()
    if (!sidebar && drawer?.open) drawer.close()
    if (!sidebar) return
    const wide = window.matchMedia('(min-width: 851px)')
    const resize = () => { if (wide.matches) setSidebar(false) }
    wide.addEventListener('change', resize)
    return () => wide.removeEventListener('change', resize)
  }, [sidebar])

  useEffect(() => {
    const element = dialogRef.current
    if (dialog && !element?.open) element?.showModal()
    if (dialog === 'search') searchInput.current?.focus()
    if (!dialog && element?.open) element.close()
  }, [dialog])

  useEffect(() => {
    if (previousView.current !== view) {
      mainRef.current?.focus({ preventScroll: true })
      previousView.current = view
    }
    document.title = views[view].title + ' · DocuScripter'
  }, [view])

  function go(next: View, template?: Template) {
    if (!viewEnabled(next)) return
    setSelected(template)
    setView(next)
    setSidebar(false)
    setDialog(null)
    if (readView() !== next) window.location.hash = next
    window.scrollTo(0, 0)
  }

  function nav(next: View) {
    if (!viewEnabled(next)) return null
    const Icon = views[next].icon
    return <a className={'nav-item' + (view === next ? ' active' : '')} aria-current={view === next ? 'page' : undefined}
      key={next} href={'#' + next} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        go(next)
      }}><Icon size={18} strokeWidth={1.65} /><span>{views[next].title}</span></a>
  }

  const pages = (Object.keys(views) as View[]).filter(entry => viewEnabled(entry) && (entry !== 'team' || canAdmin) && (entry !== 'billing' || tenant.role === 'owner') &&
    (identity.canProcess || !['generate', 'convert', 'batches'].includes(entry)))
  const term = query.trim().toLowerCase()
  const matches = pages.filter(entry => views[entry].title.toLowerCase().includes(term))
  const templateMatches = term ? templates.filter(item => item.name.toLowerCase().includes(term)) : []
  function sidebarContent(mobile = false) {
    return <>
      <div className="rail-heading"><button className="brand-link" aria-label="DocuScripter overview" onClick={() => go('overview')}><Brand /></button>
        {mobile && <button className="icon-button" aria-label="Close navigation" onClick={() => setSidebar(false)}><X size={18} /></button>}</div>
      <a className="workspace-card" href={workspaceConfig.appOrigin} aria-label={'Switch organization, current organization ' + tenant.name}>
        <span className="workspace-mark"><Building2 size={17} /></span><span><strong>{tenant.name}</strong><small>Switch organization</small></span><ChevronsUpDown size={14} />
      </a>
      <nav aria-label="Workspace navigation">
        <div className="nav-group"><span className="label">Workspace</span>{(['overview', 'templates', 'activity'] as const).map(nav)}</div>
        <div className="nav-group"><span className="label">Document tools</span>
          {identity.canProcess && (['generate', 'convert', 'batches'] as const).map(nav)}
          <a className="nav-item" href={workspaceConfig.routing === 'path' ? '/editor.html?workspace=' + encodeURIComponent(tenant.slug) : '/editor.html'} target="_blank" rel="noopener"><FilePenLine size={18} strokeWidth={1.65} />DOCX editor <ArrowUpRight size={13} className="external-icon" /><span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </nav>
      <div className="sidebar-bottom">{tenant.role === 'owner' && nav('billing')}{canAdmin && nav('team')}
        <button className="account-chip" onClick={() => go('account')}><span className="avatar">{initials}</span>
          <span><strong>{identity.name}</strong><small>{identity.role}</small></span><ChevronRight size={15} className="account-chevron" /></button>
      </div>
    </>
  }

  const descriptions = {
    batches: 'Turn spreadsheet rows into individually named Word documents or PDFs.',
    generate: 'Combine a Word template with runtime values to create an editable document.',
    convert: 'Turn Word documents and HTML files into shareable PDFs.',
    templates: 'Browse starter layouts and the Word templates saved by your organization.',
    activity: 'Review the documents processed in this organization.',
    account: 'Review your identity and the permissions assigned to your organization membership.',
    team: 'Manage organization members, settings and access history.',
    billing: 'Review your organization’s license and subscription options.',
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      <aside className="sidebar sidebar-desktop">{sidebarContent()}</aside>
      <dialog id="workspace-navigation" ref={mobileNav} className="mobile-drawer" aria-label="Workspace menu"
        onClose={() => setSidebar(false)} onClick={event => { if (event.target === event.currentTarget) setSidebar(false) }}>
        {sidebar && <div className="sidebar">{sidebarContent(true)}</div>}
      </dialog>
      <div className="workspace-main">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" aria-expanded={sidebar} aria-controls="workspace-navigation" onClick={() => setSidebar(true)}><Menu size={21} /></button>
          <div className="breadcrumbs"><button onClick={() => go('overview')}>Workspace</button><ChevronRight size={13} /><strong>{views[view].title}</strong></div>
          <div className="top-actions">
            <button className="search-button" aria-label="Search workspace" aria-keyshortcuts="Meta+K Control+K" onClick={() => { setQuery(''); setDialog('search') }}><Search size={16} /><span>Search workspace</span><kbd>{shortcut}</kbd></button>
            <button className="icon-button" aria-label="Recent updates" title="Recent updates" onClick={() => setDialog('notifications')}><Bell size={18} /></button>
          </div>
        </header>

        <main ref={mainRef} id="main-content" tabIndex={-1} className="main-content">
          {dataError && <div className="error-box" role="alert">{dataError} <button className="button secondary" disabled={loadingData} onClick={onDataChange}>Retry</button></div>}
          {loadingData && view !== 'overview' && <p className="sr-only" role="status">Loading workspace data…</p>}
          {view === 'overview' ? <OverviewPage items={items} templates={templates} pinnedIds={pinnedIds} tenantName={tenant.name} canProcess={identity.canProcess} loading={loadingData} navigate={go} openNewDocument={() => setDialog('new')} /> : <>
            <div className="page-heading detail-heading"><div><h1>{views[view].title}</h1><p>{descriptions[view]}</p></div></div>
            {view === 'generate' && <DocumentWorkflow key={selected?.id || 'upload'} kind="DOCX" identity={identity} selected={selected} templates={templates} onComplete={onDataChange} />}
            {view === 'batches' && <BatchPage templates={templates} canProcess={identity.canProcess} onComplete={onDataChange} />}
            {view === 'convert' && <DocumentWorkflow kind="PDF" identity={identity} templates={templates} onComplete={onDataChange} />}
            {view === 'activity' && <>
              <div className="section-heading"><span>{items.length} jobs loaded</span><button className="button secondary" disabled={loadingData} onClick={onDataChange}>Refresh</button></div>
              <div className="panel"><ActivityTable items={items} onChange={identity.canProcess ? onDataChange : undefined} currentUserId={identity.id} /></div>
              {nextOffset !== null && <button className="button secondary load-more" disabled={loadingMore || loadingData} onClick={() => { void loadMore() }}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
            </>}
            {view === 'templates' && <TemplatesPage key={selected?.id || 'library'} templates={templates} initialTemplateId={selected?.id} pinnedIds={pinnedIds} onTogglePin={togglePin} currentUserId={identity.id} canProcess={identity.canProcess} onSelect={(template) => go('generate', template)} onChange={onDataChange} />}
            {view === 'team' && (canAdmin ? <TenantAccessPage /> : <p className="form-note">Organization administrator access is required.</p>)}
            {view === 'billing' && (tenant.role === 'owner' ? <BillingPage /> : <p className="form-note">Only the organization owner can manage billing.</p>)}
            {view === 'account' && <section className="panel account-panel">
              <div className="form-heading"><span className="avatar">{initials}</span><div><h2>{identity.name}</h2><p>{identity.email || 'Workspace account'}</p></div></div>
              <dl><dt>Organization</dt><dd>{tenant.name}</dd><dt>Organization role</dt><dd>{identity.role}</dd><dt>Document processing</dt><dd>{identity.canProcess ? 'Allowed' : 'View only'}</dd><dt>Identity provider</dt><dd>Supabase Auth</dd></dl>
              {accountError && <p className="error-box" role="alert">{accountError}</p>}
              <button className="button secondary" onClick={() => {
                if (window.confirm('Leave this organization? You will lose access to its documents and templates.')) {
                  void api('/api/tenant/leave', { method: 'POST' }).then(onTenantChange).catch((cause) => setAccountError(cause instanceof Error ? cause.message : 'Could not leave the organization.'))
                }
              }}>Leave organization</button>
              <button className="button secondary" disabled={signingOut} onClick={() => {
                setAccountError(''); setSigningOut(true)
                void signOut().catch(() => setAccountError('Sign-out failed. Please try again.')).finally(() => setSigningOut(false))
              }}><LogOut size={17} /> {signingOut ? 'Signing out…' : 'Sign out'}</button>
            </section>}
          </>}
        </main>
      </div>

      <dialog ref={dialogRef} className="dialog" aria-labelledby="dialog-title" onClose={() => setDialog(null)} onClick={(event) => { if (event.target === event.currentTarget) setDialog(null) }}
        onKeyDown={event => {
          if (dialog !== 'search' || event.nativeEvent.isComposing) return
          const results = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.dialog-list button'))
          const i = results.indexOf(document.activeElement as HTMLButtonElement)
          if (i < 0 && document.activeElement !== searchInput.current) return
          if (event.key === 'ArrowDown' && results.length) {
            event.preventDefault()
            results[Math.min(i + 1, results.length - 1)].focus()
          } else if (event.key === 'ArrowUp' && i >= 0) {
            event.preventDefault()
            if (i === 0) searchInput.current?.focus()
            else results[i - 1].focus()
          } else if (event.key === 'Enter' && i < 0 && results.length) {
            event.preventDefault()
            results[0].click()
          }
        }}>
        {dialog && <div className="dialog-body">
          <div className="dialog-heading"><h2 id="dialog-title">{dialog === 'search' ? 'Search workspace' : dialog === 'new' ? 'New document' : 'Recent updates'}</h2>
            <button className="icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={19} /></button></div>
          {dialog === 'search' && <><label className="dialog-search"><Search size={18} /><input ref={searchInput} aria-label="Search tools and templates" aria-describedby="search-keys" placeholder="Find a page or template…" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <span id="search-keys" className="sr-only">Use the arrow keys to move between results and Enter to open one.</span>
            <div className="dialog-list">{matches.map(entry => { const Icon = views[entry].icon; return <button key={entry} onClick={() => go(entry)}><Icon size={17} />{views[entry].title}{view === entry ? <Check size={15} /> : <ChevronRight size={15} />}</button> })}
              {templateMatches.length > 0 && <h3>Templates</h3>}
              {templateMatches.map(item => <button key={item.id} onClick={() => go(identity.canProcess ? 'generate' : 'templates', item)}><FileText size={17} />{item.name}<ChevronRight size={15} /></button>)}
              {!matches.length && !templateMatches.length && <p>No matching pages or templates.</p>}</div></>}
          {dialog === 'new' && <div className="dialog-list">{documentActions().map(({ view: target, title, icon: Icon }) => <button key={target} onClick={() => go(target)}><Icon size={19} /> {title}<ChevronRight size={16} /></button>)}</div>}
          {dialog === 'notifications' && <div className="dialog-list">{items.length
            ? items.slice(0, 4).map((item) => <button key={item.id} onClick={() => go('activity')}><FileText size={18} /> {item.name}: {item.status === 'ready' ? 'ready' : item.status === 'failed' ? 'failed' : 'processing'} <ChevronRight size={16} /></button>)
            : <p>You’re all caught up.</p>}</div>}
        </div>}
      </dialog>
    </div>
  )
}
