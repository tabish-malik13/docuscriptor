import { createRoot } from 'react-dom/client'
import '@docx-editor.dev/core/styles/editor.css'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './editor.css'
import { DocxEditorPage } from './DocxEditorPage'
import { canonicalEntry } from '../workspace/organization-location'
import { loadFeatures } from '../shared/features'
import { initializeAuth } from '../auth/supabase-auth'

async function start() {
  // A local document remains editable if the gateway is offline. Reload to reconnect to a workspace.
  try { await loadFeatures() } catch { /* Continue with all workspace features disabled. */ }
  initializeAuth()
  createRoot(document.getElementById('root')!).render(<DocxEditorPage />)
}
if (canonicalEntry) window.location.replace(canonicalEntry)
else void start()
