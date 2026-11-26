import { useCallback, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, Download, FileDown, FileText, LoaderCircle } from 'lucide-react'
import type { WorkspaceIdentity } from '../auth/supabase-auth'
import { documentFilename } from '../../../shared/document-filename.mjs'
import { download } from '../shared/download'
import { features } from '../shared/features'
import { encode } from './api'
import { FilePicker } from './FilePicker'
import { LiveDocxPreview } from './LiveDocxPreview'
import { useTenantApi } from './TenantContext'
import type { Template } from './starter-templates'

const maxFileSize = 4 * 1024 * 1024

function readValues(json: string): Record<string, string> {
  let values
  try { values = JSON.parse(json) } catch { throw new Error('Enter valid JSON for the template values.') }
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) {
    throw new Error('Enter a JSON object with text values for your placeholders.')
  }
  return values
}

export function DocumentWorkflow({ kind, identity, selected, templates, onComplete }: {
  kind: 'DOCX' | 'PDF'
  identity: WorkspaceIdentity
  selected?: Template
  templates: Template[]
  onComplete: () => void
}) {
  const { api, downloadSaved } = useTenantApi()
  const [chosenTemplate, setChosenTemplate] = useState(selected)
  const [file, setFile] = useState<File | null>(null)
  const encodedFile = useRef<{ file: File; bytes: Promise<string> } | null>(null)
  const [uploadChoice, setUploadChoice] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [json, setJson] = useState('{}')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const word = kind === 'DOCX'
  const preview = word && features.livePreview
  const currentTemplate = word ? templates.find(entry => entry.id === chosenTemplate?.id) : undefined
  // A background library refresh must not switch the revision under a partially filled form.
  const template = currentTemplate ? chosenTemplate : undefined
  const templateId = template?.id
  const saved = template?.saved
  const version = template?.version

  const sourceInput = useCallback(async () => {
    if (templateId) return saved ? { savedTemplateId: templateId, savedTemplateVersion: version } : { templateId }
    if (!file) throw new Error('Choose a source file.')
    if (file.size > maxFileSize) throw new Error('Choose a file that is 4 MB or smaller.')
    if (encodedFile.current?.file !== file) encodedFile.current = { file, bytes: encode(file) }
    return { file: await encodedFile.current.bytes, filename: file.name }
  }, [file, templateId, saved, version])

  const wordInput = useCallback(async () => {
    const tokens = templateId ? values : readValues(json.trim() || '{}')
    return { ...await sourceInput(), values: tokens }
  }, [values, json, sourceInput, templateId])

  const renderPreview = useCallback(async (signal: AbortSignal) => {
    const payload = await wordInput()
    signal.throwIfAborted()
    const response = await api('/api/docx/preview', { method: 'POST', body: JSON.stringify(payload), signal })
    return response.arrayBuffer()
  }, [api, wordInput])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !identity.canProcess) return
    setError('')
    setResult(null)
    setBusy(true)
    try {
      const payload = word ? await wordInput() : await sourceInput()
      const response = await api(word ? '/api/docx/generate' : '/api/pdf/convert', {
        method: 'POST', body: JSON.stringify(payload),
      })
      const name = documentFilename(template?.name ?? file!.name, kind)
      const artifact = await response.blob()
      const id = response.headers.get('X-Document-Id')
      if (id) setResult({ id, name })
      download(artifact, name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed. Please try again.')
    } finally {
      setBusy(false)
      onComplete()
    }
  }

  return (
    <div className={'document-workflow' + (preview ? ' generate-workflow' : word ? ' form-only-workflow' : '')}>
      <form className="panel workflow-form" onSubmit={submit}>
        <div className="workflow-section-title"><h2>{word ? 'Source and fields' : 'Source file'}</h2></div>
        <fieldset disabled={busy || !identity.canProcess}>
          {word && <label className="field">Word template
            <select aria-label="Word template" value={templateId ?? 'upload'} onChange={(event) => {
              setChosenTemplate(templates.find(item => item.id === event.target.value))
              setFile(null); setValues({}); setJson('{}'); setError(''); setResult(null); encodedFile.current = null
            }}>
              <option value="upload">Upload a Word template</option>
              {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          {features.templateVersions && currentTemplate?.version && version && currentTemplate.version > version && <div className="form-note">
            This draft uses version {version}.{' '}
            <button className="button secondary" type="button" onClick={() => {
              setChosenTemplate(currentTemplate)
              setValues(previous => Object.fromEntries(Object.entries(previous).filter(([field]) => currentTemplate.fields.includes(field))))
              setResult(null); setError('')
            }}>Use version {currentTemplate.version}</button>
          </div>}
          {!template && <FilePicker label={word ? 'Upload a Word template' : 'Upload a file to convert'}
            hint={word ? 'Word (.docx) · Up to 4 MB' : 'Word (.docx) or self-contained HTML · Up to 4 MB'}
            accept={word ? '.docx' : '.docx,.html,.htm'} filename={file?.name ?? ''} onChange={value => {
              setFile(value ?? null); setJson('{}'); setUploadChoice(n => n + 1); setResult(null); setError(''); encodedFile.current = null
            }} required />}
          {word && (template
            ? <div className="field-grid">{template.fields.map((field) => <label key={field} className="field">
              {field[0].toUpperCase() + field.slice(1).replaceAll('_', ' ')}
              <input name={field} required maxLength={4000} value={Object.hasOwn(values, field) ? values[field] : ''}
                onChange={event => {
                  const next = { ...values, [field]: event.target.value }
                  if (next[field] === '') delete next[field]
                  setValues(next); setResult(null)
                }} />
            </label>)}</div>
            : <label className="field">Field values (JSON)
              <span className="field-hint">Match the placeholders in your Word file. For <code>{'{customer_name}'}</code>, supply a <code>customer_name</code> value.</span>
              <textarea name="values" rows={5} required spellCheck={false} value={json} onChange={event => { setJson(event.target.value); setResult(null) }} />
            </label>)}
          {!word && <p className="form-note file-guidance">For HTML files, embed the images and styles in the source file.</p>}
        </fieldset>
        {!identity.canProcess && <p className="form-note">Ask your administrator for document processing access.</p>}
        {error && <p role="alert" className="error-box">{error}</p>}
        {result && <div className="success-box" role="status"><CheckCircle2 size={17} /> {result.name} is ready.
          <button className="icon-button" type="button" aria-label="Download result" onClick={() => { void downloadSaved('/api/jobs/' + result.id + '/download', result.name).catch((cause) => setError(cause instanceof Error ? cause.message : 'Download failed.')) }}><Download size={17} /></button>
        </div>}
        <div className="workflow-submit">
          <button className="button primary" type="submit" disabled={busy || !identity.canProcess}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <FileDown size={16} />}
            {busy ? 'Processing…' : word ? 'Generate DOCX' : 'Convert to PDF'}
          </button>
        </div>
      </form>
      {preview && <LiveDocxPreview key={template ? template.id + '/' + (version ?? '') : 'upload/' + uploadChoice}
        available={identity.canProcess && !!(template || file)} render={renderPreview} />}
      {!word && <aside className="panel output-summary">
        <div className="output-details"><h2>Output</h2>
          <div className="output-file"><FileText aria-hidden="true" size={19} /><strong>PDF document</strong></div>
          <p>The finished file downloads automatically. You can get another copy from Activity.</p>
        </div>
      </aside>}
    </div>
  )
}
