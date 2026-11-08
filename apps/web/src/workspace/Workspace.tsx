import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUpRight, Bell, ChevronRight, CircleHelp, FilePenLine, FileText,
  LayoutTemplate, LogOut, Menu, Search, X,
} from 'lucide-react'
import { signOut, type Identity } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'
import { ActivityTable } from './ActivityTable'
import { DocumentWorkflow } from './DocumentWorkflow'
import type { Activity } from './activity'
import { actions, readView, views, type View } from './navigation'
import { templates, type Template } from './starter-templates'

type Dialog = 'search' | 'notifications' | 'new'

export function Workspace({ identity }: { identity: Identity }) {
  const [view, setView] = useState(readView)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [query, setQuery] = useState('')
  const [sidebar, setSidebar] = useState(false)
  const [selected, setSelected] = useState<Template>()
  const [items, setItems] = useState<Activity[]>([])
  const [accountError, setAccountError] = useState('')
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
    activity: 'Review documents generated or converted during this session.',
    account: 'Review your identity and the permissions assigned to your workspace account.',
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      {sidebar && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
      <aside id="workspace-navigation" className={'sidebar' + (sidebar ? ' open' : '')}>
        <button className="brand-link" aria-label="DocuScripter overview" onClick={() => go('overview')}><Brand /></button>
        <div className="workspace-card">
          <span className="workspace-mark">D</span><div><strong>My workspace</strong><small>Document operations</small></div>
        </div>
        <nav aria-label="Workspace navigation">
          <div className="nav-group"><span className="label">WORKSPACE</span>
            {(['overview', 'generate', 'convert'] as const).map(nav)}
            <a className="nav-item" href="/editor.html" target="_blank" rel="noopener"><FilePenLine size={18} strokeWidth={1.8} /> DOCX editor <span className="sr-only">(opens in a new tab)</span></a>
          </div>
          <div className="nav-group"><span className="label">LIBRARY</span>{(['templates', 'activity'] as const).map(nav)}</div>
        </nav>
        <div className="sidebar-bottom">
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
          {view === 'overview' ? <OverviewPage items={items} navigate={go} openNewDocument={() => setDialog('new')} /> : <>
            <button className="back-link" onClick={() => go('overview')}><ArrowLeft size={16} /> Overview</button>
            <div className="page-heading detail-heading"><div><h1>{views[view].title}</h1><p>{descriptions[view]}</p></div></div>
            {view === 'generate' && <DocumentWorkflow key={selected?.id || 'upload'} kind="DOCX" identity={identity} selected={selected} onComplete={(item) => setItems((current) => [item, ...current].slice(0, 20))} />}
            {view === 'convert' && <DocumentWorkflow kind="PDF" identity={identity} onComplete={(item) => setItems((current) => [item, ...current].slice(0, 20))} />}
            {view === 'activity' && <div className="panel"><ActivityTable items={items} /></div>}
            {view === 'templates' && <div className="action-grid">{templates.map((template) =>
              <button className="action-card template-card" key={template.id} onClick={() => go('generate', template)}>
                <span className={'icon-chip ' + template.tone}><LayoutTemplate size={21} /></span><ArrowUpRight className="card-arrow" size={17} />
                <span className="label">{template.category}</span><strong>{template.name}</strong><small>{template.description}</small>
              </button>)}</div>}
            {view === 'account' && <section className="panel account-panel">
              <div className="form-heading"><span className="avatar">{initials}</span><div><h2>{identity.name}</h2><p>{identity.email || 'Workspace account'}</p></div></div>
              <dl><dt>Workspace role</dt><dd>{identity.role}</dd><dt>Document processing</dt><dd>{identity.canProcess ? 'Allowed' : 'View only'}</dd><dt>Identity provider</dt><dd>Supabase Auth</dd></dl>
              {accountError && <p className="error-box" role="alert">{accountError}</p>}
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
            ? items.slice(0, 4).map((item) => <button key={item.id} onClick={() => go('activity')}><FileText size={18} /> {item.name} is ready <ChevronRight size={16} /></button>)
            : <p>You’re all caught up.</p>}</div>}
        </div>}
      </dialog>
    </div>
  )
}
