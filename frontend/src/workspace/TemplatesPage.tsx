import { useState, type FormEvent } from 'react'
import { ArrowUpRight, Download, LayoutTemplate, Trash2 } from 'lucide-react'
import { encode } from './api'
import { useTenantApi } from './TenantContext'
import type { Template } from './starter-templates'

export function TemplatesPage({ templates, canProcess, currentUserId, onSelect, onChange }: {
  templates: Template[]; canProcess: boolean; currentUserId: string; onSelect: (template: Template) => void; onChange: () => void
}) {
  const { api, downloadSaved, tenant } = useTenantApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(work: () => Promise<void>) {
    if (busy) return
    setError(''); setBusy(true)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Template request failed.') }
    finally { setBusy(false) }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    void run(async () => {
      const file = data.get('file') as File
      if (!file?.size || file.size > 4 * 1024 * 1024 || !/\.docx$/i.test(file.name)) throw new Error('Choose a DOCX file that is 4 MB or smaller.')
      await api('/api/templates', { method: 'POST', body: JSON.stringify({ name: String(data.get('name')).trim(), filename: file.name, file: await encode(file) }) })
      form.reset(); onChange()
    })
  }
  return <>
    {canProcess && <form className="panel workflow-form template-upload" onSubmit={save}>
      <h2>Save a Word template</h2>
      <p className="form-note">Upload a DOCX with fields such as {'{customer_name}'}. Saved templates are shared with members of this organization.</p>
      <fieldset disabled={busy}>
        <label className="field">Template name<input name="name" required maxLength={120} /></label>
        <label className="field">Word template<input name="file" type="file" accept=".docx" required /></label>
        <button className="button primary" type="submit">{busy ? 'Saving…' : 'Save template'}</button>
      </fieldset>
    </form>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="action-grid">{templates.map((template) => <div className="panel template-entry" key={template.id}>
      <button className="action-card template-card" onClick={() => onSelect(template)}>
        <span className={'icon-chip ' + template.tone}><LayoutTemplate size={21} /></span><ArrowUpRight className="card-arrow" size={17} />
        <span className="label">{template.category}</span><strong>{template.name}</strong><small>{template.description}</small>
      </button>
      {template.saved && <div className="template-actions">
        <button className="button secondary" disabled={busy} onClick={() => { void run(() => downloadSaved('/api/templates/' + template.id + '/download', template.name + '.docx')) }}><Download size={15} /> Download</button>
        {canProcess && (template.createdBy === currentUserId || tenant.role === 'owner' || tenant.role === 'admin') && <button className="icon-button" disabled={busy} aria-label={'Delete template ' + template.name} onClick={() => {
          if (window.confirm('Delete this saved template? Existing generated documents will remain.')) void run(async () => {
            await api('/api/templates/' + template.id, { method: 'DELETE' }); onChange()
          })
        }}><Trash2 size={16} /></button>}
      </div>}
    </div>)}</div>
  </>
}
