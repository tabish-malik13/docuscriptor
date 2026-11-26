import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './workspace.css'
import { WorkspaceApp } from './WorkspaceApp'
import { canonicalEntry } from './organization-location'
import { features, loadFeatures } from '../shared/features'
import { initializeAuth } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'

const root = createRoot(document.getElementById('root')!)
async function start() {
  root.render(<p className="directory-status" role="status">Opening workspace…</p>)
  try {
    await loadFeatures()
  } catch {
    root.render(<main className="directory-body"><Brand /><section className="directory-unavailable">
      <h1>Workspace unavailable</h1><p role="alert">The workspace settings could not be loaded.</p>
      <button className="button primary" onClick={() => { void start() }}>Try again</button>{' '}
      <a className="button secondary" href="/editor.html">Open local editor</a>
    </section></main>)
    return
  }
  if (!features.auth) { window.location.replace('/editor.html'); return }
  initializeAuth()
  root.render(<WorkspaceApp />)
}
if (canonicalEntry) window.location.replace(canonicalEntry)
else void start()
