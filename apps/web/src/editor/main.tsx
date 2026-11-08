import { createRoot } from 'react-dom/client'
import '@docx-editor.dev/core/styles/editor.css'
import '@fontsource-variable/inter'
import '../shared/base.css'
import './editor.css'
import { DocxEditorPage } from './DocxEditorPage'

createRoot(document.getElementById('root')!).render(<DocxEditorPage />)
