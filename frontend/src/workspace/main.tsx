import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './workspace.css'
import { WorkspaceApp } from './WorkspaceApp'
import { canonicalEntry } from './organization-location'

if (canonicalEntry) window.location.replace(canonicalEntry)
else createRoot(document.getElementById('root')!).render(<WorkspaceApp />)
