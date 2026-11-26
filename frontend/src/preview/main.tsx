import { createRoot } from 'react-dom/client'
import { DocxEditor, useEditorState } from '@docx-editor.dev/react'
import '@docx-editor.dev/core/styles/editor.css'
import './preview.css'

// Only the workspace that embedded this viewer supplies document bytes.
const root = createRoot(document.getElementById('root')!)
const fitPage = { type: 'fit', fit: 'pageWidth', minZoom: 0.24, maxZoom: 1 } as const
const fixed = { type: 'fixed' } as const
let bytes: Uint8Array | undefined
let actualSize = false

function PreviewPages() {
  const error = useEditorState(state => state.parseError)
  if (error) return <p role="alert">The Word document could not be displayed.</p>
  return <DocxEditor.Viewport className="preview-viewport"><DocxEditor.Content /></DocxEditor.Viewport>
}

window.addEventListener('message', event => {
  if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return
  if (event.data?.type === 'docx-preview' && event.data.bytes instanceof ArrayBuffer) bytes = new Uint8Array(event.data.bytes)
  else if (event.data?.type === 'docx-preview-zoom' && typeof event.data.actualSize === 'boolean') actualSize = event.data.actualSize
  else return
  if (!bytes) return
  const viewport = document.querySelector('.preview-viewport')
  const top = viewport?.scrollTop ?? 0
  const left = viewport?.scrollLeft ?? 0
  root.render(<DocxEditor.Root document={bytes} mode="view" zoom={actualSize ? 1 : undefined} zoomMode={actualSize ? fixed : fitPage} colorMode="light"
    onReady={() => document.querySelector('.preview-viewport')?.scrollTo(left, top)}>
    <PreviewPages />
  </DocxEditor.Root>)
})
