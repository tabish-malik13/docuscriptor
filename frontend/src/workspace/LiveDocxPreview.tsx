import { useEffect, useRef, useState } from 'react'
import { FileText, LoaderCircle, Maximize2, Minimize2 } from 'lucide-react'
import { WorkspaceRequestError } from './api'

export function LiveDocxPreview({ available, render }: {
  available: boolean
  render: (signal: AbortSignal) => Promise<ArrayBuffer>
}) {
  const panel = useRef<HTMLElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const retryAt = useRef(0)
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null)
  const [loading, setLoading] = useState(available)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')

  useEffect(() => {
    if (!available) return
    const controller = new AbortController()
    let timer: number
    setLoading(true)
    setError('')
    async function update() {
      try {
        const document = await render(controller.signal)
        if (controller.signal.aborted) return
        setBytes(document)
        setError('')
        setLoading(false)
      } catch (cause) {
        if (controller.signal.aborted) return
        setBytes(null)
        setLoading(false)
        if (cause instanceof WorkspaceRequestError && cause.status === 429 && cause.retryAfter !== null) {
          const delay = Math.max(1, cause.retryAfter) * 1000
          retryAt.current = Date.now() + delay
          setError('Preview limit reached. The preview will update automatically.')
          timer = window.setTimeout(() => setAttempt(n => n + 1), delay)
        } else {
          setError(cause instanceof Error ? cause.message : 'The document preview could not be loaded.')
        }
      }
    }
    timer = window.setTimeout(() => { void update() }, Math.max(450, retryAt.current - Date.now()))
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [available, render, attempt])

  function sendDocument() {
    if (bytes) frame.current?.contentWindow?.postMessage({ type: 'docx-preview', bytes }, location.origin)
  }
  function sendZoom() {
    frame.current?.contentWindow?.postMessage({ type: 'docx-preview-zoom', actualSize }, location.origin)
  }
  useEffect(() => { sendDocument() }, [bytes])
  useEffect(() => { sendZoom() }, [actualSize])
  useEffect(() => {
    const sync = () => setExpanded(document.fullscreenElement === panel.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  return <section ref={panel} className="panel live-docx-preview" aria-label="Live document preview">
    <div className="live-preview-heading">
      <div><FileText size={18} aria-hidden="true" /><h2>Live preview</h2></div>
      <span className="live-preview-status" role="status">{loading && available && <><LoaderCircle size={13} className="spin" aria-hidden="true" /><span>Updating…</span></>}</span>
      {bytes && <select className="preview-zoom" aria-label="Preview zoom" value={actualSize ? 'actual' : 'fit'} onChange={event => setActualSize(event.target.value === 'actual')}>
        <option value="fit">Fit width</option><option value="actual">100%</option>
      </select>}
      {document.fullscreenEnabled && bytes && <button type="button" className="icon-button" title={expanded ? 'Exit full screen' : 'Expand preview'}
        aria-label={expanded ? 'Exit full screen' : 'Expand preview'} onClick={() => {
          const change = expanded ? document.exitFullscreen() : panel.current?.requestFullscreen()
          setFullscreenError('')
          void change?.catch(() => setFullscreenError('Full screen is unavailable in this browser.'))
        }}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
    </div>
    {fullscreenError && <p role="alert" className="live-preview-notice">{fullscreenError}</p>}
    {available && bytes && <iframe ref={frame} src="/preview.html" onLoad={() => { sendDocument(); sendZoom() }} title="Read-only Word document" />}
    {(!available || !bytes) && <div className="live-preview-empty">
      {!available ? <p>Choose or upload a Word template to see its pages here.</p> : error ? <>
        <p role="alert">{error}</p>{retryAt.current <= Date.now() && <button type="button" className="button secondary" onClick={() => setAttempt(n => n + 1)}>Retry preview</button>}
      </> : <p>Opening preview…</p>}
    </div>}
  </section>
}
