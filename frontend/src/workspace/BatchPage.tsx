import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, FolderArchive, History, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { download } from '../shared/download'
import { WorkspaceRequestError } from './api'
import { BatchForm, type BatchFormat, type BatchMode } from './BatchForm'
import { useTenantApi } from './TenantContext'
import type { Template } from './starter-templates'
import './batch.css'

type BatchSummary = {
  id: string
  templateName: string
  format: BatchFormat
  created: string
  total: number
  pending: number
  processing: number
  ready: number
  failed: number
}
type Batch = BatchSummary & { rows: {
  index: number
  name: string
  status: 'pending' | 'processing' | 'ready' | 'failed'
  jobId: string | null
  error: string | null
  available: boolean
  size: number
}[] }

const batchPath = (id: string) => '/api/batches/' + encodeURIComponent(id)
const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The batch request failed.'

function waitForAdmission(seconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, seconds * 1000)
    function cancel() { window.clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function reviewNotice(batch: Batch) {
  const first = batch.rows[0]
  if (first.available) return 'Download ' + first.name + ' to review it.' + (batch.pending ? ' Select Resume batch to generate the remaining files.' : '')
  if (first.status === 'failed') return 'The first row failed. Review its error below before continuing.'
  if (first.status === 'processing') return 'The first file is processing. Select Refresh to check its status.'
  if (first.status === 'ready') return 'The first file was removed from Activity.'
  return 'The first row is still pending. Refresh to check its status.'
}

export function BatchPage({ templates, canProcess, onComplete }: { templates: Template[]; canProcess: boolean; onComplete: () => void }) {
  const { api } = useTenantApi()
  const [history, setHistory] = useState<BatchSummary[]>([])
  const [historyError, setHistoryError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [busy, setBusy] = useState<'process' | 'other' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const action = useRef<AbortController | null>(null)
  const mutations = useRef(0)
  useLayoutEffect(() => {
    if (!canProcess) {
      setBusy(null); setBatch(null); setHistory([]); setNotice(''); setError('')
    }
    return () => {
      action.current?.abort()
      action.current = null
    }
  }, [canProcess])
  useEffect(() => {
    if (!canProcess) return
    const request = new AbortController()
    const start = mutations.current
    setLoading(true)
    setHistoryError('')
    void (async () => {
      try {
        const result = await (await api('/api/batches', { signal: request.signal })).json()
        if (!request.signal.aborted && start === mutations.current) setHistory(result.items)
      } catch (cause) { if (!request.signal.aborted) setHistoryError(errorMessage(cause)) }
      finally { if (!request.signal.aborted) setLoading(false) }
    })()
    return () => request.abort()
  }, [api, canProcess, revision])

  async function act(kind: 'process' | 'other', work: (signal: AbortSignal) => Promise<void>) {
    if (action.current) return
    const request = new AbortController()
    action.current = request
    setBusy(kind); setError(''); setNotice('')
    try { await work(request.signal) }
    catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)) }
    finally {
      if (action.current === request) {
        action.current = null
        if (!request.signal.aborted) setBusy(null)
      }
    }
  }

  function show(result: Batch) {
    mutations.current++
    setBatch(result)
    setHistory(items => [result, ...items.filter(item => item.id !== result.id)]
      .sort((a, b) => b.created.localeCompare(a.created)))
  }

  async function readBatch(id: string, signal: AbortSignal) {
    const result: Batch = await (await api(batchPath(id), { signal })).json()
    signal.throwIfAborted()
    show(result)
    return result
  }

  async function process(initial: Batch, signal: AbortSignal, mode: BatchMode = 'all') {
    let current = initial
    try {
      while (current.pending && !current.processing) {
        signal.throwIfAborted()
        const nextRow = mode === 'review' ? current.rows[0] : current.rows.find(row => row.status === 'pending')
        if (nextRow?.status !== 'pending') break
        try {
          const response = await retryAdmission(() => {
            setNotice(mode === 'review' ? 'Generating the first file for review.' : 'Generating files. Keep this page open to continue the batch.')
            return api(batchPath(current.id) + '/next?row=' + nextRow.index, { method: 'POST', signal })
          }, signal)
          current = await response.json()
          signal.throwIfAborted()
          show(current)
          if (mode === 'review') break
        } catch (cause) {
          signal.throwIfAborted()
          if (cause instanceof WorkspaceRequestError && (cause.status === 401 || cause.status === 403)) {
            setNotice('Processing paused.')
            throw cause
          }
          // A lost response may still have created an artifact. Read the authoritative row states before offering Resume.
          setNotice('Processing paused. Refresh the row states before resuming.')
          const recovered = await readBatch(current.id, signal)
          if (mode === 'review' && recovered.rows[0].status !== 'pending') {
            current = recovered
            break
          }
          setNotice('Processing paused. The row states below are up to date.')
          throw cause
        }
      }
      setNotice(mode === 'review' ? reviewNotice(current) : current.processing ? 'A row is running. Refresh to check its progress.' : '')
    } finally {
      if (!signal.aborted) {
        setRevision(value => value + 1)
        onComplete()
      }
    }
  }

  function create(body: string, key: string, mode: BatchMode) {
    void act('process', async signal => {
      let result: Batch
      try {
        const response = await retryAdmission(() => api('/api/batches', { method: 'POST', headers: { 'Idempotency-Key': key }, body, signal }), signal)
        result = await response.json()
      } catch (cause) {
        signal.throwIfAborted()
        if (!(cause instanceof WorkspaceRequestError)) {
          setRevision(value => value + 1)
          setNotice('Checking batch history. You can submit the same roster again to recover its batch.')
        }
        throw cause
      }
      signal.throwIfAborted()
      show(result)
      await process(result, signal, mode)
    })
  }

  function pause() {
    action.current?.abort()
    action.current = null
    setBusy(null); setNotice('Paused. Any submitted row can finish. Open the batch from history to check its status.')
    setRevision(value => value + 1)
    onComplete()
  }

  async function retryAdmission<T>(submit: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      signal.throwIfAborted()
      try { return await submit() }
      catch (cause) {
        if (!(cause instanceof WorkspaceRequestError) || ![429, 503].includes(cause.status) || cause.retryAfter === null) throw cause
        const seconds = Math.max(1, cause.retryAfter)
        setNotice('Capacity is busy. Continuing in ' + seconds + (seconds === 1 ? ' second.' : ' seconds.'))
        await waitForAdmission(seconds, signal)
      }
    }
  }

  function discard(id: string) {
    if (!window.confirm('Discard this batch and its remaining row data? Generated documents will still be available in Activity.')) return
    void act('other', async signal => {
      await api(batchPath(id), { method: 'DELETE', signal })
      signal.throwIfAborted()
      mutations.current++
      setHistory(items => items.filter(item => item.id !== id))
      setBatch(null)
      setNotice('Batch discarded.')
      setRevision(value => value + 1)
    })
  }

  function fetchFile(path: string, name: string, archive = false) {
    void act('other', async signal => {
      try {
        const response = await api(path, { signal })
        const artifact = await response.blob()
        signal.throwIfAborted()
        download(artifact, name)
        if (archive && Number(response.headers.get('X-Batch-Omitted-Count')) > 0) {
          const included = response.headers.get('X-Batch-File-Count')
          const omitted = Number(response.headers.get('X-Batch-Omitted-Count'))
          setNotice('ZIP contains ' + included + ' of ' + (Number(included) + omitted) + ' files. Review the remaining rows before distribution.')
          if (batch) await readBatch(batch.id, signal)
        }
      } catch (cause) {
        if (archive && !(cause instanceof WorkspaceRequestError && cause.status === 409)) {
          throw new Error(errorMessage(cause) + ' Download available files individually below.')
        }
        throw cause
      }
    })
  }

  const available = batch?.rows.filter(row => row.available).length || 0
  const archiveTooLarge = (batch?.rows.reduce((bytes, row) => bytes + (row.available ? row.size : 0), 0) || 0) > 32 * 1024 * 1024
  if (!canProcess) return <p className="form-note">A document operator, admin, or owner can open and generate batches. Find generated files in Activity.</p>
  return <div className={'batch-page' + (batch ? ' showing-run' : ' showing-form')}>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p className="form-note batch-notice" role="status">{notice}</p>}
    {!batch && busy === 'process' && <button className="button secondary batch-pause" onClick={pause}><Pause size={15} />Pause</button>}
    {batch ? <section className="panel batch-detail">
      <div className="section-heading"><div><h2>{batch.templateName}</h2>
        <p>{batch.format} · {formatDate.format(new Date(batch.created))}</p></div>
        <button className="button secondary" disabled={!!busy} onClick={() => { setBatch(null); setNotice(''); setError(''); setRevision(value => value + 1) }}>
          <Plus size={15} />New batch
        </button>
      </div>
      <div className="batch-progress">
        <p aria-live="polite"><strong>{batch.ready} of {batch.total} ready</strong>
          {batch.failed > 0 && ' · ' + batch.failed + ' failed'}{batch.processing > 0 && ' · ' + batch.processing + ' processing'}
          {batch.pending > 0 && ' · ' + batch.pending + ' pending'}
        </p>
        <progress aria-label="Processed rows" value={batch.ready + batch.failed} max={batch.total} />
      </div>
      <div className="batch-controls">
        {busy === 'process' ? <button className="button secondary" onClick={pause}><Pause size={15} />Pause</button>
        : batch.pending > 0 && <button className="button primary" disabled={!!busy || !!batch.processing} onClick={() => {
          void act('process', async signal => { await process(await readBatch(batch.id, signal), signal) })
        }}><Play size={15} />Resume batch</button>}
        {busy !== 'process' && batch.total >= 2 && batch.rows[0].status === 'pending' && <button className="button secondary" disabled={!!busy || !!batch.processing} onClick={() => {
          void act('process', async signal => { await process(await readBatch(batch.id, signal), signal, 'review') })
        }}>Generate first file for review</button>}
        {available > 0 && !archiveTooLarge && <button className={'button ' + (batch.pending ? 'secondary' : 'primary')} disabled={!!busy} onClick={() => {
          fetchFile(batchPath(batch.id) + '/download', 'batch-' + batch.id + '.zip', true)
        }}><FolderArchive size={16} />Download ZIP ({available})</button>}
        <button className="button secondary" disabled={!!busy} onClick={() => { void act('other', async signal => { await readBatch(batch.id, signal) }) }}><RefreshCw size={14} />Refresh</button>
        <button className="button secondary batch-discard" disabled={!!busy || !!batch.processing} onClick={() => discard(batch.id)}>
          <Trash2 size={15} />Discard batch</button>
      </div>
      {archiveTooLarge && <p className="form-note">These files exceed the 32 MiB ZIP limit. Download them individually below.</p>}
      <div className="table-wrap" role="region" aria-label="Batch files" tabIndex={0}><table><thead><tr>
        <th scope="col">Row</th><th scope="col">Output file</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Download file</span></th>
      </tr></thead><tbody>{batch.rows.map(row => <tr key={row.index}>
        <td>{row.index}</td><td><strong className="batch-filename">{row.name}</strong>
          {row.error && <small className="job-error">{row.error}</small>}
          {row.status === 'ready' && !row.available && <small className="form-note">File removed from Activity</small>}
        </td><td><span className={'status ' + row.status}><i />{row.status[0].toUpperCase() + row.status.slice(1)}</span></td>
        <td>{row.available && row.jobId && <button className="icon-button" disabled={!!busy} aria-label={'Download ' + row.name}
          onClick={() => fetchFile('/api/jobs/' + encodeURIComponent(row.jobId!) + '/download', row.name)}><ArrowDownToLine size={16} /></button>}</td>
      </tr>)}</tbody></table></div>
    </section> : <BatchForm templates={templates} disabled={!!busy} onCreate={create} />}

    <section className="panel batch-history">
      <div className="section-heading"><div><h2>Your batch history</h2><p>Reopen a run within 30 days to resume it or download its files.</p></div>
        <button className="icon-button" disabled={!!busy || loading} aria-label="Refresh batch history" onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} /></button>
      </div>
      {historyError && <p className="error-box" role="alert">{historyError}</p>}
      {history.length ? <ul>{history.map(item => <li key={item.id}>
        <span><strong>{item.templateName}</strong><small>{formatDate.format(new Date(item.created))} · {item.format}</small></span>
        <span className="batch-history-count">{item.ready}/{item.total} ready{item.failed > 0 && ' · ' + item.failed + ' failed'}</span>
        <button className="button secondary" disabled={!!busy} aria-label={'Open ' + item.templateName + ' batch from ' + formatDate.format(new Date(item.created))}
          onClick={() => { void act('other', async signal => { await readBatch(item.id, signal) }) }}>Open</button>
      </li>)}</ul> : <div className="empty-state"><History size={18} /><p>{loading ? 'Loading batch history…' : historyError ? 'History unavailable.' : 'No batches yet.'}</p></div>}
    </section>
  </div>
}
