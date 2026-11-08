import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './workspace.css'
import { WorkspaceApp } from './WorkspaceApp'

createRoot(document.getElementById('root')!).render(<WorkspaceApp />)
