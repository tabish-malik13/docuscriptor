import { useMemo, useRef, useState } from 'react'
import { Download, FileSearch, Files } from 'lucide-react'
import { batchFilenames } from '../../../shared/batch-filenames.mjs'
import { certificateRosterIssues } from '../../../shared/certificate-roster.mjs'
import { download } from '../shared/download'
import { FilePicker } from './FilePicker'
import { csvHeaders, defaultMapping, maxCsvBytes, parseCsv, prepareBatch, type CsvSheet } from './batch-input'
import type { Template } from './starter-templates'

export type BatchFormat = 'DOCX' | 'PDF'
export type BatchMode = 'all' | 'review'

export function BatchForm({ templates, disabled, onCreate }: {
  templates: Template[]
  disabled: boolean
  onCreate: (body: string, key: string, mode: BatchMode) => void
}) {
  const [source, setSource] = useState(templates.find(item => item.id === 'certificate')?.id || templates[0]?.id || '')
  const [format, setFormat] = useState<BatchFormat>(source === 'certificate' ? 'PDF' : 'DOCX')
  const [sheet, setSheet] = useState<CsvSheet | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileError, setFileError] = useState('')
  const [columns, setColumns] = useState<Record<string, number>>({})
  const [selectedNameColumn, setNameColumn] = useState<number | null>(null)
  const fileVersion = useRef(0)
  const previous = useRef<{ body: string; key: string } | null>(null)
  const template = templates.find(item => item.id === source)
  const mapping = useMemo(() => ({ ...defaultMapping(template?.fields ?? [], sheet?.headers ?? []), ...columns }), [template, sheet, columns])
  const nameColumn = selectedNameColumn ?? (source === 'certificate' ? mapping.certificate_id ?? -1 : -1)
  const result = useMemo(() => {
    if (!sheet || !template) return null
    const { rows, issues, blankCells } = prepareBatch(sheet, template.fields, mapping, nameColumn)
    if (template.id === 'certificate') issues.push(...certificateRosterIssues(rows))
    // Many fields may reuse a column. Bound the expanded request before allocating its JSON.
    let body = ''
    if (!issues.length) {
      const limit = 2 * 1024 * 1024
      const valueLength = rows.reduce((sum, row) => sum + Object.values(row.values).reduce((n, value) => n + value.length, 0), 0)
      if (valueLength <= limit) body = JSON.stringify({ [template.saved ? 'savedTemplateId' : 'templateId']: template.id, format, rows })
      if (!body || new TextEncoder().encode(body).byteLength > limit) issues.push('The mapped data exceeds 2 MiB. Split this roster into smaller batches.')
    }
    return { rows, issues, blankCells, body, filenames: batchFilenames(rows.map(row => row.name), format) }
  }, [sheet, template, format, mapping, nameColumn])

  async function selectFile(file?: File) {
    const version = ++fileVersion.current
    setSheet(null); setColumns({}); setNameColumn(null); setFileError(''); setFileName(file?.name || '')
    if (!file) return
    try {
      if (file.size > maxCsvBytes) throw new Error('Choose a CSV of 2 MiB or less.')
      const bytes = await file.arrayBuffer()
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new Error('Export your spreadsheet as CSV UTF-8 and upload it again.') }
      const loaded = parseCsv(text)
      if (version === fileVersion.current) setSheet(loaded)
    } catch (error) {
      if (version === fileVersion.current) setFileError(error instanceof Error ? error.message : 'Could not read this file.')
    }
  }

  function submit(mode: BatchMode) {
    if (!result || result.issues.length || !result.rows.length || disabled) return
    if (previous.current?.body !== result.body) previous.current = { body: result.body, key: crypto.randomUUID() }
    onCreate(result.body, previous.current.key, mode)
  }

  return <form className="panel workflow-form batch-form" onSubmit={event => { event.preventDefault(); submit('all') }}>
    <div className="workflow-section-title"><h2>Batch setup</h2></div>
    <fieldset disabled={disabled}>
      <div className="field-grid">
        <label className="field">Word template<select value={source} onChange={event => {
          setSource(event.target.value); setFormat(event.target.value === 'certificate' ? 'PDF' : 'DOCX'); setNameColumn(null); setColumns({})
        }}>
          {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field">Output format<select value={format} onChange={event => setFormat(event.target.value as BatchFormat)}>
          <option value="DOCX">Word (.docx)</option><option value="PDF">PDF (.pdf)</option>
        </select></label>
      </div>
      <div className="batch-roster-heading"><h3>Roster</h3>
        {template && template.fields.length > 0 && <button className="batch-headers" type="button" onClick={() => {
          download(new Blob(['\uFEFF', csvHeaders(template.fields)], { type: 'text/csv;charset=utf-8' }), template.id + '-headers.csv')
        }}><Download size={14} />Download CSV headers</button>}
      </div>
      <FilePicker label="Upload CSV" hint="UTF-8 CSV with a header · Up to 100 rows · 2 MiB"
        accept=".csv,text/csv" filename={fileName} onChange={file => { void selectFile(file) }} />
      {fileError && <p className="error-box" role="alert">{fileError}</p>}
      {sheet && template && result && <>
        <h3>Match columns to template fields</h3>
        <div className="field-grid">
          {template.fields.map(field => <label className="field" key={field}>{'{' + field + '}'}
            <select value={mapping[field]} onChange={event => setColumns(current => ({ ...current, [field]: Number(event.target.value) }))}>
              <option value={-1}>Choose a column</option>
              {sheet.headers.map((header, i) => <option key={header} value={i}>{header}</option>)}
            </select>
          </label>)}
          <label className="field">File names<select value={nameColumn} onChange={event => setNameColumn(Number(event.target.value))}>
            <option value={-1}>Number each document</option>
            {sheet.headers.map((header, i) => <option key={header} value={i}>{header}</option>)}
          </select></label>
        </div>
        {result.issues.length > 0 && <div className="error-box batch-issues" role="alert">
          <strong>Check the roster</strong>
          <ul>{result.issues.slice(0, 5).map(issue => <li key={issue}>{issue}</li>)}</ul>
          {result.issues.length > 5 && <span>{result.issues.length - 5} more issues</span>}
        </div>}
        {!!result.rows.length && <div className="batch-preview">
          <h3>Preview</h3><p className="form-note">Showing {Math.min(3, result.rows.length)} of {result.rows.length} output files.</p>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Batch preview"><table><thead><tr>
            <th scope="col">File</th>{template.fields.map(field => <th scope="col" key={field}>{field}</th>)}
          </tr></thead><tbody>{result.rows.slice(0, 3).map((row, i) => <tr key={i}>
            <td>{result.filenames[i]}</td>{template.fields.map(field => <td key={field}><span className="batch-preview-value">{row.values[field] || '—'}</span></td>)}
          </tr>)}</tbody></table></div>
          {template.id !== 'certificate' && result.blankCells > 0 && <p className="form-note">{result.blankCells} mapped {result.blankCells === 1 ? 'cell is' : 'cells are'} blank and will render empty.</p>}
        </div>}
      </>}
      <p className="form-note batch-visibility">Organization members can access the files in Activity. Only you can open this batch history.</p>
      <div className="batch-controls">
        <button className="button primary" type="submit" disabled={!result || result.issues.length > 0 || !result.rows.length}>
          <Files size={16} />{result?.rows.length ? 'Generate ' + result.rows.length + (result.rows.length === 1 ? ' file' : ' files') : 'Generate files'}
        </button>
        {result && !result.issues.length && result.rows.length >= 2 && <button className="button secondary" type="button" onClick={() => submit('review')}>
          <FileSearch size={16} />Generate first file for review
        </button>}
      </div>
    </fieldset>
  </form>
}
