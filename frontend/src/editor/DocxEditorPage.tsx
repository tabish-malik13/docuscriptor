import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react'
import { openHeadlessDocument } from '@docx-editor.dev/core/store'
import { ArrowUpRight, Check, ChevronDown, Copy, Download, FilePlus2, Files, FileText, FolderOpen, History, Library, Save, X } from 'lucide-react'
import { authConfigured } from '../auth/supabase-auth'
import { Brand } from '../shared/Brand'
import { DeleteTemplateButton } from '../shared/DeleteTemplateButton'
import { download } from '../shared/download'
import { useEditorLibrary } from './useEditorLibrary'
import { TemplateVersionsDialog } from './TemplateVersionsDialog'

const maxFileBytes = 4 * 1024 * 1024
const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
type OpenDocument = { source: 'blank' | Uint8Array; filename: string; template?: { id: string; version: number }; scopeKey?: string }
const blankDocument: OpenDocument = { source: 'blank', filename: 'Untitled.docx' }
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const withoutExtension = (name: string) => name.replace(/\.docx$/i, '')
const withExtension = (name: string) => /\.docx$/i.test(name) ? name : name + '.docx'

export function DocxEditorPage() {
  const library = useEditorLibrary()
  const editor = useRef<DocxEditorRef>(null)
  const picker = useRef<HTMLInputElement>(null)
  const saveDialog = useRef<HTMLDialogElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const [opened, setOpened] = useState<OpenDocument>(blankDocument)
  const [documentId, setDocumentId] = useState(0)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [libraryExpanded, setLibraryExpanded] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [saveError, setSaveError] = useState('')
  const [namingScope, setNamingScope] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const currentScope = useRef(library.scopeKey)
  const hasUnsavedEdits = useRef(false)
  useLayoutEffect(() => {
    currentScope.current = library.scopeKey
    hasUnsavedEdits.current = dirty
  }, [library.scopeKey, dirty])

  function replaceDocument(document: OpenDocument) {
    setDocumentId(id => id + 1)
    setOpened(document)
    setReady(false)
    setDirty(false)
    setError('')
    setStatus('')
    setNamingScope(null)
    setShowHistory(false)
  }

  // A document fetched in a previous account or organization must leave the screen with it.
  if (opened.scopeKey && opened.scopeKey !== library.scopeKey) replaceDocument(blankDocument)

  useEffect(() => {
    if (!dirty) return
    function preventLoss(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])

  const showNaming = namingScope === library.scopeKey && library.canSave
  useEffect(() => {
    const dialog = saveDialog.current
    if (showNaming && dialog && !dialog.open) {
      dialog.showModal()
      nameInput.current?.select()
    } else if (!showNaming && dialog?.open) dialog.close()
  }, [showNaming])

  function mayReplace() {
    return !hasUnsavedEdits.current || window.confirm('Discard the unsaved edits in this document?')
  }

  function mayOpen(source: Uint8Array) {
    // Check the package with the editor's local reader before unmounting the current draft.
    if (!openHeadlessDocument(source).ok) throw new Error('This file could not be opened as a Word document.')
    return mayReplace()
  }

  function newBlank() {
    if (busy || !mayReplace()) return
    replaceDocument(blankDocument)
    setLibraryExpanded(false)
  }

  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || busy) return
    if (!/\.docx$/i.test(file.name) || file.size > maxFileBytes) {
      setError('Choose a .docx file that is 4 MB or smaller.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const source = new Uint8Array(await file.arrayBuffer())
      if (mayOpen(source)) {
        replaceDocument({ source, filename: file.name })
        setLibraryExpanded(false)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function openTemplate(item: { id: string; name: string }) {
    if (busy) return
    const scopeKey = library.scopeKey
    setBusy(true)
    setError('')
    try {
      const { source, version } = await library.openTemplate(item.id)
      if (scopeKey === currentScope.current && mayOpen(source)) {
        replaceDocument({ source, filename: withExtension(item.name), template: { id: item.id, version }, scopeKey })
        setLibraryExpanded(false)
      }
    } catch (cause) {
      if (scopeKey === currentScope.current) setError(cause instanceof Error ? cause.message : 'The template could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  async function exportDocx() {
    const handle = editor.current
    if (!ready || !handle || busy) return
    setBusy(true)
    setError('')
    try {
      const revision = handle.getDocumentHandle()?.revision
      const bytes = await handle.save()
      if (!bytes) throw new Error()
      if (editor.current !== handle) return
      download(new Blob([bytes], { type: docxMimeType }), opened.filename)
      if (!opened.template && handle.getDocumentHandle()?.revision === revision) setDirty(false)
      setStatus('Download started')
    } catch {
      setError('The Word document could not be downloaded. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteTemplate(id: string) {
    if (busy || !library.canSave) return
    const scopeKey = library.scopeKey
    setBusy(true)
    setError('')
    try {
      await library.deleteTemplate(id)
      if (currentScope.current !== scopeKey) return
      // Keep the open document and its in-memory edits under their original account scope.
      setOpened(previous => previous.template?.id === id ? { ...previous, template: undefined } : previous)
      setStatus('Template deleted')
    } catch (cause) {
      if (currentScope.current === scopeKey) setError(cause instanceof Error ? cause.message : 'The template could not be deleted. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function askForName() {
    if (!ready || busy || !library.canSave) return
    setTemplateName(opened.template ? (withoutExtension(opened.filename).slice(0, 113) + ' (copy)') : withoutExtension(opened.filename).slice(0, 120))
    setSaveError('')
    setNamingScope(library.scopeKey)
  }

  async function saveTemplate(name: string, updateExisting: boolean) {
    const handle = editor.current
    if (!ready || !handle || !library.canSave || busy) return
    if (!name) {
      setSaveError('Enter a template name.')
      nameInput.current?.focus()
      return
    }
    const scopeKey = library.scopeKey
    setBusy(true)
    setSaveError('')
    setError('')
    try {
      const revision = handle.getDocumentHandle()?.revision
      const bytes = await handle.save()
      if (!bytes) throw new Error('The Word document is still opening. Try again.')
      if (bytes.byteLength > maxFileBytes) throw new Error('Saved templates must be 4 MB or smaller.')
      if (scopeKey !== currentScope.current || editor.current !== handle) return
      const saved = await library.saveTemplate(name, bytes, updateExisting ? opened.template : undefined)
      if (scopeKey !== currentScope.current || editor.current !== handle) return
      setOpened({ ...opened, filename: withExtension(saved.name), template: { id: saved.id, version: saved.version }, scopeKey })
      if (handle.getDocumentHandle()?.revision === revision) setDirty(false)
      setStatus('Version ' + saved.version + ' saved')
      setError('')
      setNamingScope(null)
    } catch (cause) {
      if (scopeKey === currentScope.current) {
        const message = cause instanceof Error ? cause.message : 'The template could not be saved. Try again.'
        if (updateExisting) setError(message)
        else setSaveError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  const currentTemplate = opened.template ? library.items.find(item => item.id === opened.template?.id) : undefined
  const newerVersion = opened.template && currentTemplate && currentTemplate.version > opened.template.version ? currentTemplate : null
  function save() {
    if (!library.canSave) { void exportDocx(); return }
    if (!opened.template) { askForName(); return }
    if (hasUnsavedEdits.current && !newerVersion) void saveTemplate(withoutExtension(opened.filename), true)
  }

  function saveNamed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void saveTemplate(templateName.trim(), false)
  }

  const organization = library.organizations.find(item => item.id === library.tenantId)
  return <div className="local-editor">
    <header className="editor-topbar">
      <div className="editor-heading">
        <a className="editor-brand-link" href={library.workspaceHref} aria-label="DocuScripter workspace"><Brand /></a>
        <div className="editor-title"><div className="editor-document-heading"><h1>Template editor</h1>
          {opened.template && <button type="button" className="editor-version-link" aria-label={'Version history, editing version ' + opened.template.version}
            title="Version history" disabled={busy} onClick={() => setShowHistory(true)}><History size={14} aria-hidden="true" />Version {opened.template.version}</button>}
        </div>
          {dirty ? <span className="editor-dirty">Unsaved edits</span> : status && <span role="status"><Check size={12} aria-hidden="true" />{status}</span>}
        </div>
      </div>
      <div className="editor-actions">
        <button className="button secondary editor-open-file" title="Open DOCX" aria-label="Open DOCX" onClick={() => picker.current?.click()} disabled={busy}><FolderOpen size={16} aria-hidden="true" /><span>Open DOCX</span></button>
        <button className={'button ' + (library.canSave ? 'secondary' : 'primary')} disabled={busy || !ready} onClick={() => { void exportDocx() }}><Download size={16} aria-hidden="true" />Download DOCX</button>
        {library.canSave && opened.template && <button type="button" className="button secondary editor-copy" aria-label="Save a copy" title="Save a copy" disabled={busy || !ready}
          onClick={askForName}><Copy size={15} aria-hidden="true" /><span>Save a copy</span></button>}
        {library.canSave && <button className="button primary" disabled={busy || !ready || (!!opened.template && (!dirty || !!newerVersion))} onClick={save}>
          <Save size={16} aria-hidden="true" />{opened.template ? 'Save version' : 'Save template'}</button>}
      </div>
      <input ref={picker} type="file" accept=".docx" hidden onChange={openFile} />
    </header>
    <div className="editor-layout">
      <aside className={'editor-library' + (libraryExpanded ? ' is-expanded' : '')} aria-labelledby="editor-library-title">
        <div className="editor-library-header">
          <div className="editor-library-heading"><Library size={18} aria-hidden="true" /><h2 id="editor-library-title">My templates</h2></div>
          <button type="button" className="editor-library-toggle" aria-controls="editor-library-body" aria-expanded={libraryExpanded}
            aria-label={libraryExpanded ? 'Collapse my templates' : 'Expand my templates'} onClick={() => setLibraryExpanded(!libraryExpanded)}><ChevronDown size={18} /></button>
        </div>
        <div className="editor-library-body" id="editor-library-body">
          <button type="button" className="button editor-new" disabled={busy} onClick={newBlank}><FilePlus2 size={17} aria-hidden="true" />New blank template</button>
          {library.organizations.length > 1
            ? <label className="editor-workspace-picker">Workspace<select value={library.tenantId} disabled={busy}
                onChange={event => {
                  if (opened.scopeKey && !mayReplace()) return
                  setNamingScope(null)
                  library.selectTenant(event.target.value)
                }}>{library.organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            : organization && <p className="editor-workspace-caption">{organization.name}</p>}
          {library.status === 'loading' && <p className="editor-library-note" role="status">Loading saved templates…</p>}
          {library.status === 'signed-out' && (authConfigured ? <div className="editor-library-note">
            <p>Sign in to see your saved templates.</p>
            <a href={library.workspaceHref} target="_blank" rel="noopener">Sign in<ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
          </div> : <p className="editor-library-note">Workspace sign-in is unavailable on this installation. You can edit and download a DOCX here.</p>)}
          {library.status === 'no-workspace' && <div className="editor-library-note">
            <p>Join or create a workspace to save templates.</p>
            <a href={library.workspaceHref} target="_blank" rel="noopener">Open workspace<ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
          </div>}
          {library.status === 'error' && <div className="editor-library-note"><p role="alert">{library.error}</p><button onClick={library.retry}>Try again</button></div>}
          {library.status === 'ready' && (library.items.length
            ? <ul className="editor-template-list">{library.items.map(item => <li key={item.id}>
                <button type="button" disabled={busy} aria-current={opened.template?.id === item.id ? 'true' : undefined} onClick={() => { void openTemplate(item) }}>
                  <FileText size={17} aria-hidden="true" /><span><strong>{item.name}</strong>{Number.isFinite(item.created) && <small>{dateFormat.format(item.created)}</small>}</span>
                </button>
                {library.canSave && organization && <DeleteTemplateButton name={item.name} organization={organization.name}
                  disabled={busy} onDelete={() => { void deleteTemplate(item.id) }} />}
              </li>)}</ul>
            : <div className="editor-library-empty"><Files size={21} strokeWidth={1.6} aria-hidden="true" /><strong>No saved templates yet</strong>
                {library.canSave && <p>Save a document as a template to find it here.</p>}</div>)}
        </div>
      </aside>
      <main className="editor-main" aria-label="Word document">
        {error && <p className="editor-feedback" role="alert">{error}</p>}
        {newerVersion && <div className="editor-newer-version" role="status">
          <span>Version {newerVersion.version} is available.{dirty && ' Save a copy to keep your edits.'}</span>
          <button type="button" disabled={busy} onClick={() => { void openTemplate(newerVersion) }}>Open latest version</button>
        </div>}
        <div className="editor-surface">
          <DocxEditor key={documentId} ref={editor} document={opened.source} title={opened.filename} colorMode="light" mode="edit"
            onOpen={() => { if (!busy) picker.current?.click() }} onSave={save}
            onReady={handle => setReady(!handle.snapshot().parseError && !!handle.getDocumentHandle())}
            onChange={change => {
              if (!change.source) {
                hasUnsavedEdits.current = true
                setDirty(true)
                setStatus('')
              }
            }} />
        </div>
      </main>
    </div>
    {showHistory && opened.template && <TemplateVersionsDialog id={opened.template.id} filename={opened.filename}
      listVersions={library.listVersions} downloadVersion={library.downloadVersion} onClose={() => setShowHistory(false)} />}
    <dialog ref={saveDialog} aria-labelledby="save-template-title" className="editor-save-dialog" onClose={() => setNamingScope(null)}
      onCancel={event => { if (busy) event.preventDefault() }}>
      <form onSubmit={saveNamed}>
        <div className="editor-dialog-heading"><h2 id="save-template-title">{opened.template ? 'Save a template copy' : 'Save template'}</h2>
          <button type="button" aria-label="Close" disabled={busy} onClick={() => setNamingScope(null)}><X size={18} /></button></div>
        <p>Members of {organization?.name || 'your workspace'} can use this template.</p>
        <label>Template name<input ref={nameInput} value={templateName} onChange={event => setTemplateName(event.target.value)} required maxLength={120} disabled={busy} /></label>
        {saveError && <p className="error-box" role="alert">{saveError}</p>}
        <div className="editor-dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setNamingScope(null)}>Cancel</button>
          <button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save template'}</button></div>
      </form>
    </dialog>
  </div>
}
