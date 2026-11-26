import { useEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { documentFilename } from '../../../shared/document-filename.mjs'
import { download } from '../shared/download'
import type { TemplateVersion } from './useEditorLibrary'

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function TemplateVersionsDialog({ id, filename, listVersions, downloadVersion, onClose }: {
  id: string
  filename: string
  listVersions: (id: string, signal: AbortSignal) => Promise<TemplateVersion[]>
  downloadVersion: (id: string, version: number, signal: AbortSignal) => Promise<Blob>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const activeDownload = useRef<AbortController | null>(null)
  const [versions, setVersions] = useState<TemplateVersion[] | null>(null)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latestName = versions?.[0]?.name ?? filename

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { activeDownload.current?.abort() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    listVersions(id, controller.signal).then(items => {
      if (!controller.signal.aborted) setVersions(items)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Version history could not be loaded.')
    })
    return () => controller.abort()
  }, [id, attempt, listVersions])

  async function exportVersion({ version, name }: TemplateVersion) {
    const controller = new AbortController()
    activeDownload.current = controller
    setDownloading(version)
    setError('')
    try {
      const bytes = await downloadVersion(id, version, controller.signal)
      const versionFilename = documentFilename(name ?? filename, 'DOCX').replace(/\.docx$/, ' - v' + version + '.docx')
      if (!controller.signal.aborted) download(bytes, versionFilename)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'This version could not be downloaded.')
    } finally {
      if (!controller.signal.aborted) setDownloading(null)
    }
  }

  return <dialog className="editor-save-dialog editor-history-dialog" ref={dialog} aria-labelledby="version-history-heading" onClose={onClose}>
    <div className="editor-dialog-heading"><h2 id="version-history-heading">Version history</h2>
      <button type="button" aria-label="Close version history" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
    <p className="editor-history-name">{latestName}</p>
    {error && <p role="alert" className="error-box">{error} {!versions && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}</p>}
    {!versions && !error && <p role="status">Loading versions…</p>}
    {versions && <ol className="editor-versions">{versions.map((item, index) => <li key={item.version}>
      <div><strong>Version {item.version}{index === 0 && <small>Latest</small>}</strong>
        {item.name && item.name !== latestName && <p className="editor-version-name">{item.name}</p>}
        <time dateTime={item.created}>{when.format(new Date(item.created))}</time></div>
      <button type="button" disabled={downloading !== null} className="button secondary" aria-label={'Download version ' + item.version}
        onClick={() => { void exportVersion(item) }}><Download size={15} aria-hidden="true" />{downloading === item.version ? 'Downloading…' : 'Download'}</button>
    </li>)}</ol>}
  </dialog>
}
