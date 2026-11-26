import { createRoot } from 'react-dom/client'
import '@docx-editor.dev/core/styles/editor.css'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './editor.css'
import { DocxEditorPage } from './DocxEditorPage'
import { canonicalEntry } from '../workspace/organization-location'

if (canonicalEntry) window.location.replace(canonicalEntry)
else createRoot(document.getElementById('root')!).render(<DocxEditorPage />)
