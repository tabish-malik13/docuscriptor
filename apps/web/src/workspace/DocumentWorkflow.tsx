import { useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, Download, FileText, LoaderCircle, UploadCloud } from 'lucide-react'
import { accessToken, type Identity } from '../auth/supabase-auth'
import { download } from '../shared/download'
import type { Activity } from './activity'
import { templates, type Template } from './starter-templates'

const maxFileSize = 4 * 1024 * 1024

function encode(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}

export function DocumentWorkflow({ kind, identity, selected, onComplete }: {
  kind: 'DOCX' | 'PDF'
  identity: Identity
  selected?: Template
  onComplete: (activity: Activity) => void
}) {
  const [source, setSource] = useState<string>(selected?.id ?? 'upload')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Activity | null>(null)
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
      const payload = word
        ? { ...input, templateId: template?.id, values: template
          ? Object.fromEntries(template.fields.map((field) => [field, form.get(field)]))
          : JSON.parse(String(form.get('values'))) }
        : input
      const response = await fetch(word ? '/api/docx/generate' : '/api/pdf/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await accessToken() },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.message || 'The service could not process this document.')
      }
      const name = (template?.name ?? file!.name.replace(/\.[^.]+$/, '')) + '.' + kind.toLowerCase()
      const activity = {
        id: crypto.randomUUID(), name, kind, source: template ? template.name + ' template' : file!.name,
        when: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
        artifact: await response.blob(),
      }
      setResult(activity)
      onComplete(activity)
      download(activity.artifact, activity.name)
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'Enter valid JSON for the template values.' :
        cause instanceof Error ? cause.message : 'The request failed. Please try again.')
    } finally {
      setBusy(false)
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
          {word && (template
            ? <div className="field-grid">{template.fields.map((field) => <label key={field} className="field">
              {field[0].toUpperCase() + field.slice(1).replaceAll('_', ' ')}
              <input name={field} required maxLength={4000} />
            </label>)}</div>
            : <label className="field">Runtime values
              <textarea name="values" rows={5} required spellCheck={false} />
            </label>)}
        </fieldset>
        {!identity.canProcess && <p className="form-note">Ask your administrator for document processing access.</p>}
        {error && <p role="alert" className="error-box">{error}</p>}
        {result?.artifact && <div className="success-box" role="status"><CheckCircle2 size={17} /> {result.name} is ready.
          <button className="icon-button" type="button" aria-label="Download result" onClick={() => download(result.artifact!, result.name)}><Download size={17} /></button>
        </div>}
        <button className="button primary" type="submit" disabled={busy || !identity.canProcess}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}
          {busy ? 'Processing…' : word ? 'Generate DOCX' : 'Convert to PDF'}
        </button>
      </form>
      <aside className="panel workflow-tip">
        <span className="label">BEFORE YOU START</span>
        <h2>{word ? 'Use template fields' : 'Prepare your source'}</h2>
        <p>{word ? <>Add placeholders such as <code>{'{customer_name}'}</code> in your Word file. Then provide a matching value in the JSON editor.</> :
          'Embed the images and styles your HTML needs. The converter uses the file you provide and the fonts installed on the server.'}</p>
      </aside>
    </div>
  )
}
