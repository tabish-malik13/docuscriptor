import { processingEnabled } from './features'
import { useState } from 'react'
import { ArrowDownToLine, Clock3, FileText, Trash2 } from 'lucide-react'
import { useTenantApi } from './TenantContext'
import type { Activity } from './activity'

export function ActivityTable({ items, onChange, currentUserId }: { items: Activity[]; onChange?: () => void; currentUserId?: string }) {
  const { api, downloadSaved, tenant } = useTenantApi()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  async function act(item: Activity, remove = false) {
    if (busy) return
    if (remove && !window.confirm('Delete this saved document?')) return
    setBusy(item.id); setError('')
    try {
      if (remove) { await api('/api/jobs/' + item.id, { method: 'DELETE' }); onChange?.() }
      else await downloadSaved('/api/jobs/' + item.id + '/download', item.name)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The document request failed.') }
    finally { setBusy(null) }
  }
  if (!items.length) return <div className="empty-state"><span className="icon-chip violet"><Clock3 size={21} /></span>
    <div><strong>{processingEnabled ? 'No activity yet' : 'No documents yet'}</strong><p>{processingEnabled ? 'Your document jobs and saved downloads will appear here.' : 'Upload a DOCX or PDF to share it with your organization.'}</p></div>
  </div>
  return <>
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="table-wrap"><table><thead><tr><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Document actions</span></th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.id}>
        <td><div className="document-cell"><span className={'file-icon ' + (item.kind === 'DOCX' ? 'violet' : 'rose')}><FileText size={17} /></span>
          <div><strong>{item.name}</strong><small>{item.source}</small>{item.error && <small className="job-error">{item.error}</small>}</div></div></td>
        <td><span className={'format ' + item.kind.toLowerCase()}>{item.kind}</span></td>
        <td><span className={'status ' + item.status}><i /> {item.status === 'ready' ? 'Ready' : item.status === 'failed' ? 'Failed' : 'Processing'}</span></td>
        <td className="date-cell">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.when))}</td>
        <td><div className="row-actions">
          {item.status === 'ready' && <button className="icon-button" disabled={busy !== null} aria-label={'Download ' + item.name} onClick={() => { void act(item) }}><ArrowDownToLine size={17} /></button>}
          {onChange && item.status !== 'processing' && (item.createdBy === currentUserId || tenant.role === 'owner' || tenant.role === 'admin') && <button className="icon-button" disabled={busy !== null} aria-label={'Delete ' + item.name} onClick={() => { void act(item, true) }}><Trash2 size={16} /></button>}
        </div></td>
      </tr>)}</tbody></table></div>
  </>
}
