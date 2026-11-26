import { useState } from 'react'
import { ArrowRight, ChevronRight, Plus } from 'lucide-react'
import { ActivityTable } from './ActivityTable'
import type { Activity } from './activity'
import { actions, type View } from './navigation'
import { TemplatePreview } from './TemplatePreview'
import type { Template } from './starter-templates'

type OverviewProps = {
  items: Activity[]
  templates: Template[]
  pinnedIds: readonly string[]
  tenantName: string
  canProcess: boolean
  loading: boolean
  navigate: (view: View, template?: Template) => void
  openNewDocument: () => void
}

export function OverviewPage({ items, templates, pinnedIds, tenantName, canProcess, loading, navigate, openNewDocument }: OverviewProps) {
  const [expanded, setExpanded] = useState(false)
  const pinned = pinnedIds.flatMap(id => templates.find(template => template.id === id) ?? [])
  const shelf = pinned.length ? pinned : templates.filter(template => !template.saved)
  return <div className="overview">
    <header className="page-heading">
      <div><h1>Workspace overview</h1><p>{canProcess ? 'Create and manage documents for ' : 'Browse templates and documents for '}{tenantName}.</p></div>
      {canProcess && <button className="button primary" onClick={openNewDocument}><Plus size={17} />New document</button>}
    </header>

    {canProcess && <section className="tool-strip" aria-label="Document tools">
      {actions.filter(action => action.view !== 'templates').map(({ view, title, text, icon: Icon }) =>
        <button key={view} onClick={() => navigate(view)}><span className={'tool-symbol tool-' + view}><Icon size={21} strokeWidth={1.65} /></span>
          <span><strong>{title}</strong><small>{text}</small></span><ChevronRight className="tool-arrow" size={15} /></button>)}
    </section>}

    <section className="home-section" aria-labelledby="template-shelf-title">
      <div className="section-heading"><h2 id="template-shelf-title">{pinned.length ? 'Pinned templates' : 'Starter templates'}</h2>
        <button className="text-action" onClick={() => navigate('templates')}>Browse templates <ArrowRight size={15} /></button></div>
      <div className="template-shelf">
        {(expanded ? shelf : shelf.slice(0, 4)).map(template => <button key={template.id} className="shelf-card"
          onClick={() => navigate(canProcess ? 'generate' : 'templates', template)}>
          <TemplatePreview template={template} />
          <span className="shelf-caption"><strong>{template.name}</strong>
            <small>{template.saved ? 'Saved template' : template.category[0] + template.category.slice(1).toLowerCase()}<span aria-hidden="true">·</span>{template.fields.length} {template.fields.length === 1 ? 'field' : 'fields'}</small></span>
        </button>)}
      </div>
      {shelf.length > 4 && <button className="text-action shelf-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : 'Show all ' + shelf.length + ' pins'}</button>}
    </section>

    <section className="home-section" aria-labelledby="recent-activity">
      <div className="section-heading"><h2 id="recent-activity">Recent activity</h2>
        <button className="text-action" onClick={() => navigate('activity')}>View activity <ArrowRight size={15} /></button></div>
      <div className="panel">{loading && !items.length ? <p className="loading-line" role="status">Loading recent activity…</p> : <ActivityTable items={items.slice(0, 5)} />}</div>
    </section>
  </div>
}
