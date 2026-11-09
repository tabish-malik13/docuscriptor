import { processingEnabled } from './features'
import { ArrowRight, ArrowUpRight, FilePenLine, Plus, Sparkles } from 'lucide-react'
import { DocumentFlowIllustration } from '../shared/DocumentFlowIllustration'
import { ActivityTable } from './ActivityTable'
import type { Activity } from './activity'
import { actions, type View } from './navigation'

export function OverviewPage({ items, navigate, openNewDocument }: {
  items: Activity[]
  navigate: (view: View) => void
  openNewDocument: () => void
}) {
  return <>
            <div className="page-heading">
              <div><div className="overview-label"><span /> DOCUMENT WORKSPACE</div><h1>Workspace overview</h1><p>{processingEnabled ? 'Create, convert, and manage your documents in one place.' : 'Edit Word documents and manage your organization’s private files.'}</p></div>
              <div className="heading-actions">
                <a className="button secondary" href="/editor.html" target="_blank" rel="noopener"><FilePenLine size={16} /> Edit DOCX <span className="sr-only">(opens in a new tab)</span></a>
                {processingEnabled ? <button className="button primary" onClick={() => openNewDocument()}><Plus size={18} /> New document</button> : <button className="button primary" onClick={() => navigate('activity')}><Plus size={18} /> Upload document</button>}
              </div>
            </div>
            <section className="hero" aria-labelledby="hero-title">
              <div className="hero-content"><span className="hero-label"><Sparkles size={13} /> {processingEnabled ? 'DOCUMENT AUTOMATION' : 'YOUR ORGANIZATION’S DOCUMENTS'}</span>
                <h2 id="hero-title">{processingEnabled ? <>From data to finished<br className="desktop-break" /> documents.</> : <>Your documents.<br />One shared workspace.</>}</h2>
                <p>{processingEnabled ? 'Fill a Word template with your data or convert a file to PDF.' : 'Create and edit DOCX files in your browser, then save them to your organization’s private library.'}</p>
                <button className="hero-link" onClick={() => navigate(processingEnabled ? 'generate' : 'activity')}>{processingEnabled ? 'Start generating' : 'Open documents'} <ArrowRight size={16} /></button>
              </div>
              <DocumentFlowIllustration />
            </section>
            <section className="home-section" aria-labelledby="quick-actions">
              <div className="section-heading"><h2 id="quick-actions">Quick actions</h2></div>
              <div className="action-grid">{actions.map(({ view: target, icon: Icon, title, text, tone }) =>
                <button className="action-card" key={target} onClick={() => navigate(target)}><span className={'icon-chip ' + tone}><Icon size={21} strokeWidth={1.8} /></span>
                  <ArrowUpRight className="card-arrow" size={17} /><strong>{title}</strong><small>{text}</small></button>)}
              </div>
            </section>
            <section className="home-section activity-section" aria-labelledby="recent-activity">
              <div className="section-heading"><div><h2 id="recent-activity">Recent activity</h2><p>{processingEnabled ? 'Your latest document runs and exports.' : 'Your recently saved documents.'}</p></div>
                <button className="button secondary" onClick={() => navigate('activity')}>View activity <ArrowRight size={15} /></button></div>
              <div className="panel"><ActivityTable items={items.slice(0, 3)} /></div>
            </section>
          </>
}
