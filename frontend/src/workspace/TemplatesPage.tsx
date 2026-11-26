import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronRight, Download, FileText, Pin, Search, Upload, X } from 'lucide-react'
import { DeleteTemplateButton } from '../shared/DeleteTemplateButton'
import { features } from '../shared/features'
import { documentFilename } from '../../../shared/document-filename.mjs'
import { deleteSavedTemplate, encode } from './api'
import { FilePicker } from './FilePicker'
import { TemplatePreview } from './TemplatePreview'
import { useTenantApi } from './TenantContext'
import type { Template } from './starter-templates'

export function TemplatesPage({ templates, canProcess, currentUserId, onSelect, onChange, pinnedIds = [], onTogglePin, initialTemplateId }: {
  templates: Template[]
  canProcess: boolean
  currentUserId: string
  onSelect: (template: Template) => void
  onChange: () => void
  initialTemplateId?: string
  pinnedIds?: readonly string[]
  onTogglePin?: (id: string) => void
}) {
  const { api, downloadSaved, tenant } = useTenantApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<Template | undefined>(() => templates.find(item => item.id === initialTemplateId))
  const dialog = useRef<HTMLDialogElement>(null)
  const uploadButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal()
    if (!preview && dialog.current?.open) dialog.current.close()
  }, [preview])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setError(''); setNotice(''); setBusy(true)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Template request failed.') }
    finally { setBusy(false) }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void run(async () => {
      const name = String(data.get('name')).trim()
      const file = data.get('file') as File
      if (!name) throw new Error('Enter a template name.')
      if (!file?.size || file.size > 4 * 1024 * 1024 || !/\.docx$/i.test(file.name)) throw new Error('Choose a DOCX file that is 4 MB or smaller.')
      await api('/api/templates', { method: 'POST', body: JSON.stringify({ name, filename: file.name, file: await encode(file) }) })
      setFilename(''); setAdding(false); setQuery(''); setNotice(name + ' was added to organization templates.'); onChange()
      uploadButton.current?.focus()
    })
  }

  function pin(template: Template) {
    if (!onTogglePin) return null
    const pinned = pinnedIds.includes(template.id)
    const label = (pinned ? 'Unpin ' : 'Pin ') + template.name
    return <button type="button" className={'icon-button template-pin' + (pinned ? ' is-pinned' : '')}
      title={label} aria-label={label} aria-pressed={pinned} onClick={() => onTogglePin(template.id)}><Pin size={16} /></button>
  }

  const term = query.trim().toLocaleLowerCase()
  const filtered = templates.filter(item => [item.name, item.category, ...item.fields].some(value => value.toLocaleLowerCase().includes(term)))
  const starters = filtered.filter(item => !item.saved)
  const saved = filtered.filter(item => item.saved)
  return <div className="template-library">
    <div className="template-toolbar">
      <label className="library-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search templates</span>
        <input type="search" placeholder="Search templates" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      {canProcess && <button className="button secondary" ref={uploadButton} aria-expanded={adding} aria-controls="upload-template-form"
        onClick={() => { setAdding(value => !value); setFilename(''); setError(''); setNotice('') }}>
        {adding ? <X size={16} /> : <Upload size={16} />}{adding ? 'Close upload' : 'Upload template'}
      </button>}
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p className="success-box" role="status">{notice}</p>}
    {canProcess && adding && <form id="upload-template-form" className="panel workflow-form library-upload" onSubmit={save}>
      <div className="workflow-section-title"><h2>Upload a Word template</h2><p>Organization members can use the template once you save it.</p></div>
      <fieldset disabled={busy}>
        <label className="field">Template name<input name="name" required maxLength={120} /></label>
        <FilePicker label="Word template" name="file" accept=".docx" required filename={filename}
          onChange={file => setFilename(file?.name || '')} hint="Word (.docx) · Up to 4 MB" />
        <button className="button primary" type="submit">{busy ? 'Saving…' : 'Save template'}</button>
      </fieldset>
    </form>}
    {starters.length > 0 && <section aria-labelledby="starter-title">
      <h2 className="library-section-title" id="starter-title">Starter templates</h2>
      <div className="starter-shelf">{starters.map(item => <article className="starter-tile" key={item.id}>
        <button className="template-preview-button" aria-label={'Preview ' + item.name} onClick={() => setPreview(item)}>
          <TemplatePreview template={item} />
        </button>
        <div className="starter-info"><div className="starter-title-row"><h3>{item.name}</h3>{pin(item)}</div>
          <small>{item.category.charAt(0) + item.category.slice(1).toLowerCase()} · {item.fields.length} fields</small>
          <button className="template-use" onClick={() => canProcess ? onSelect(item) : setPreview(item)}>
            {canProcess ? 'Use template' : 'View template'}<ChevronRight size={15} />
          </button>
        </div>
      </article>)}</div>
    </section>}
    {saved.length > 0 && <section aria-labelledby="saved-title">
      <h2 className="library-section-title" id="saved-title">Organization templates</h2>
      <ul className="panel saved-templates">{saved.map(item => <li key={item.id}>
        <span className="saved-template-icon" aria-hidden="true"><FileText size={19} /></span>
        <button className="saved-template-name" onClick={() => setPreview(item)}><strong>{item.name}</strong><small>
          {item.fields.length} {item.fields.length === 1 ? 'field' : 'fields'} · Word template</small></button>
        <div className="saved-template-actions">
          {pin(item)}
          <button className="icon-button" type="button" disabled={busy} title="Download template" aria-label={'Download ' + item.name}
            onClick={() => { void run(() => downloadSaved('/api/templates/' + item.id + '/download', documentFilename(item.name, 'DOCX'))) }}><Download size={16} /></button>
          {features.templateDeletion && canProcess && (item.createdBy === currentUserId || tenant.role === 'owner' || tenant.role === 'admin') &&
            <DeleteTemplateButton name={item.name} organization={tenant.name} disabled={busy} onDelete={() => { void run(async () => {
              await deleteSavedTemplate(api, item.id)
              setNotice(item.name + ' was deleted from ' + tenant.name + '.')
              onChange()
            }) }} />}
          {canProcess && <button className="button secondary" onClick={() => onSelect(item)}>Use template</button>}
        </div>
      </li>)}</ul>
    </section>}
    {!filtered.length && <div className="panel library-empty" role="status"><Search size={20} /><div><strong>No matching templates</strong>
      <p>Try another name or field.</p></div><button className="button secondary" onClick={() => setQuery('')}>Clear search</button></div>}
    <dialog ref={dialog} className="dialog template-dialog" aria-labelledby="template-dialog-title" onClose={() => setPreview(undefined)}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}>
      {preview && <div className="template-dialog-body">
        <div className="dialog-heading"><h2 id="template-dialog-title">{preview.name}</h2><button className="icon-button" aria-label="Close preview"
          onClick={() => dialog.current?.close()}><X size={18} /></button></div>
        {!preview.saved && <div className={'template-full-preview preview-' + preview.id}><img alt={preview.name + ' layout'}
          src={'/template-previews/' + preview.id + '.webp'} /></div>}
        <h3>Template fields</h3>
        {preview.fields.length ? <ul className="template-fields">{preview.fields.map(field => <li key={field}><code>{field}</code></li>)}</ul>
          : <p className="form-note">This document has no fields to fill.</p>}
        {canProcess && <button className="button primary" onClick={() => { dialog.current?.close(); onSelect(preview) }}>Use template<ChevronRight size={15} /></button>}
      </div>}
    </dialog>
  </div>
}
