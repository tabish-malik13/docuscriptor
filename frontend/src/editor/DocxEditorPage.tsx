import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react'
import { ArrowLeft, Download, FilePenLine, FilePlus2, FolderOpen } from 'lucide-react'
import { download } from '../shared/download'

const maxFileBytes = 4 * 1024 * 1024
const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
type OpenDocument = { source: 'blank' | Uint8Array; filename: string }

export function DocxEditorPage() {
  const editor = useRef<DocxEditorRef>(null)
  const picker = useRef<HTMLInputElement>(null)
  const documentId = useRef(0)
  const [opened, setOpened] = useState<OpenDocument | null>(null)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!dirty) return
    function preventLoss(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])

  function openDocument(document: OpenDocument) {
    documentId.current++
    setReady(false)
    setDirty(false)
    setError('')
    setStatus('')
    setOpened(document)
  }

  function blank() {
    if (!busy && (!dirty || window.confirm('Replace this document and discard its unsaved edits?'))) {
      openDocument({ source: 'blank', filename: 'Untitled.docx' })
    }
  }

  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || busy) return
    setError('')
    if (!/\.docx$/i.test(file.name) || file.size > maxFileBytes) {
      setError('Choose a .docx file that is 4 MB or smaller.')
      return
    }
    setBusy(true)
    try {
      const source = new Uint8Array(await file.arrayBuffer())
      if (source[0] !== 0x50 || source[1] !== 0x4b) {
        setError('This file is not a Word document.')
        return
      }
      if (!dirty || window.confirm('Replace this document and discard its unsaved edits?')) {
        openDocument({ source, filename: file.name })
      }
    } catch {
      setError('The file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    const handle = editor.current
    if (!opened || !handle || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const revision = handle.getDocumentHandle()?.revision
      const bytes = await handle.save()
      if (!bytes) throw new Error('Document is not ready')
      download(new Blob([bytes], { type: docxMimeType }), opened.filename)
      if (handle.getDocumentHandle()?.revision === revision) setDirty(false)
      setStatus('DOCX download started.')
    } catch {
      setError('The Word document could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="local-editor">
    <header className="editor-topbar">
      <a href="/" className="back-link"><ArrowLeft size={16} /> Workspace</a>
      <div><h1>DOCX editor</h1><p>Open, edit, and download Word files in your browser.</p></div>
      <div className="heading-actions">
        <button className="button secondary" onClick={blank} disabled={busy}><FilePlus2 size={16} /> New blank</button>
        <button className="button secondary" onClick={() => picker.current?.click()} disabled={busy}><FolderOpen size={16} /> Open DOCX</button>
        {opened && <button className="button primary" disabled={busy || !ready} onClick={() => { void save() }}><Download size={16} /> Download DOCX</button>}
      </div>
      <input ref={picker} type="file" accept=".docx" hidden onChange={openFile} />
    </header>
    {error && <p className="error-box editor-message" role="alert">{error}</p>}
    {status && <p className="sr-only" role="status">{status}</p>}
    {opened ? <section className="editor-surface" aria-label="Word document">
      <DocxEditor key={documentId.current} ref={editor} document={opened.source} title={opened.filename} mode="edit"
        onOpen={() => { if (!busy) picker.current?.click() }}
        onSave={() => { void save() }}
        onReady={() => setReady(true)}
        onChange={(change) => {
          if (!change.source) {
            setDirty(true)
            setStatus('')
          }
        }} />
    </section> : <section className="panel editor-empty">
      <span className="icon-chip violet"><FilePenLine size={22} /></span>
      <h2>Open a Word document or start blank</h2>
      <p>Use the editor to make changes, then download your DOCX. Files stay on this device.</p>
    </section>}
  </main>
}
