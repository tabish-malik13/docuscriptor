import { useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, Download, FileText, LoaderCircle, UploadCloud } from 'lucide-react'
import type { WorkspaceIdentity } from '../auth/supabase-auth'
import { download } from '../shared/download'
import { encode } from './api'
import { useTenantApi } from './TenantContext'
import type { Template } from './starter-templates'

const maxFileSize = 4 * 1024 * 1024

function usesStructuredValues(template?: Template) {
  return Boolean(template?.fields.some((field) => field.includes('[]')))
}

function structuredValueExample(fields: readonly string[]) {
  const value: Record<string, unknown> = {}
  const repeatedRoots = new Set(fields.flatMap((field) => {
    const match = field.match(/^([A-Za-z][A-Za-z0-9_]*)\[\]/)
    return match ? [match[1]] : []
  }))
  for (const field of fields) {
    if (!field.includes('.') && !repeatedRoots.has(field)) value[field] = ''
  }
  for (const field of fields.filter((item) => item.includes('[]'))) {
    const parts = field.split('.')
    let scope = value
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      const repeated = part.endsWith('[]')
      const key = repeated ? part.slice(0, -2) : part
      if (repeated) {
        const rows = (scope[key] as unknown[] | undefined) ?? [{}]
        scope[key] = rows
        if (!rows.length) rows.push({})
        scope = rows[0] as Record<string, unknown>
      } else if (index === parts.length - 1) {
        scope[key] ??= ''
      } else {
        scope[key] ??= {}
        scope = scope[key] as Record<string, unknown>
      }
    }
  }
  return JSON.stringify(value, null, 2)
}

export function DocumentWorkflow({ kind, identity, selected, templates, onComplete }: {
  kind: 'DOCX' | 'PDF'
  identity: WorkspaceIdentity
  selected?: Template
  templates: Template[]
  onComplete: () => void
}) {
  const { api, downloadSaved } = useTenantApi()
  const [source, setSource] = useState<string>(selected?.id ?? 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const word = kind === 'DOCX'
  const template = word ? templates.find((entry) => entry.id === source) : undefined

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !identity.canProcess) return
    const form = new FormData(event.currentTarget)
    setError('')
    setResult(null)
    setBusy(true)
    try {
      if (!template && !file) throw new Error('Choose a source file.')
      if (file && file.size > maxFileSize) throw new Error('Choose a file that is 4 MB or smaller.')
      const input = template ? {} : { file: await encode(file!), filename: file!.name }
      const structured = usesStructuredValues(template)
      const payload = word
        ? { ...input, templateId: template?.saved ? undefined : template?.id, savedTemplateId: template?.saved ? template.id : undefined, values: template && !structured
          ? Object.fromEntries(template.fields.map((field) => [field, form.get(field)]))
          : JSON.parse(String(form.get('values'))) }
        : input
      const response = await api(word ? '/api/docx/generate' : '/api/pdf/convert', {
        method: 'POST', body: JSON.stringify(payload),
      })
      const name = (template?.name ?? file!.name).replace(/\.[^.]+$/, '') + '.' + kind.toLowerCase()
      const artifact = await response.blob()
      const id = response.headers.get('X-Document-Id')
      if (id) setResult({ id, name })
      download(artifact, name)
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'Enter valid JSON for the template values.' :
        cause instanceof Error ? cause.message : 'The request failed. Please try again.')
    } finally {
      setBusy(false)
      onComplete()
    }
  }

  return (
    <div className="workflow-grid">
      <form className="panel workflow-form" onSubmit={submit}>
        <div className="form-heading"><span className={'icon-chip ' + (word ? 'violet' : 'mint')}><FileText size={21} /></span>
          <div><h2>{word ? 'Document source' : 'File to convert'}</h2><p>{word ? 'Select a starter or upload a Word template.' : 'Upload a DOCX or self-contained HTML file.'}</p></div>
        </div>
        <fieldset disabled={busy}>
          {word && <label className="field">Source
            <select value={source} onChange={(event) => { setSource(event.target.value); setFile(null); setError(''); setResult(null) }}>
              <option value="upload">Upload a Word template</option>
              {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          {!template && <label className="dropzone">
            <UploadCloud size={22} />
            <strong>{file?.name || 'Choose a source file'}</strong>
            <span>{word ? 'DOCX' : 'DOCX or HTML'} · up to 4 MB</span>
            <input type="file" accept={word ? '.docx' : '.docx,.html,.htm'} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>}
          {word && (template && !usesStructuredValues(template)
            ? <div className="field-grid">{template.fields.map((field) => <label key={field} className="field">
              {field[0].toUpperCase() + field.slice(1).replaceAll('_', ' ')}
              <input name={field} required maxLength={4000} />
            </label>)}</div>
            : <label className="field">Runtime values
              <textarea key={template?.id ?? 'upload'} name="values" rows={8} required spellCheck={false}
                defaultValue={template ? structuredValueExample(template.fields) : undefined} />
            </label>)}
        </fieldset>
        {!identity.canProcess && <p className="form-note">Ask your administrator for document processing access.</p>}
        {error && <p role="alert" className="error-box">{error}</p>}
        {result && <div className="success-box" role="status"><CheckCircle2 size={17} /> {result.name} is ready.
          <button className="icon-button" type="button" aria-label="Download result" onClick={() => { void downloadSaved('/api/jobs/' + result.id + '/download', result.name).catch((cause) => setError(cause instanceof Error ? cause.message : 'Download failed.')) }}><Download size={17} /></button>
        </div>}
        {busy && <p className="form-note" role="status">The first request may take up to two minutes while the converter wakes up. Please keep this page open.</p>}
        <button className="button primary" type="submit" disabled={busy || !identity.canProcess}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}
          {busy ? 'Processing…' : word ? 'Generate DOCX' : 'Convert to PDF'}
        </button>
      </form>
      <aside className="panel workflow-tip">
        <span className="label">BEFORE YOU START</span>
        <h2>{word ? 'Use template fields' : 'Prepare your source'}</h2>
        <p>{word ? <>Use fields such as <code>{'{customer_name}'}</code> or <code>{'{{customer_name}}'}</code>. Repeat rows with sections such as <code>{'{{#items}}'}…{'{{/items}}'}</code>, and provide arrays of objects in the JSON editor.</> :
          'Embed the images and styles your HTML needs. The converter uses the file you provide and the fonts installed on the server.'}</p>
      </aside>
    </div>
  )
}
