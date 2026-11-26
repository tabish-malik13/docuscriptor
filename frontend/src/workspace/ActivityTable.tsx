import { useState } from 'react'
import { ArrowDownToLine, FileClock, FileText, Search, Trash2 } from 'lucide-react'
import { useTenantApi } from './TenantContext'
import type { Activity } from './activity'
import './document-ui.css'

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const statusLabels = { ready: 'Ready', failed: 'Failed', processing: 'Processing' }

export function ActivityTable({ items, onChange, currentUserId }: { items: Activity[]; onChange?: () => void; currentUserId?: string }) {
  const { api, downloadSaved, tenant } = useTenantApi()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const rows = items.filter(item => (!status || item.status === status) &&
    [item.name, item.source, item.kind].some(value => value.toLocaleLowerCase().includes(term)))

  async function act(item: Activity, remove = false) {
    if (busy) return
    if (remove && !window.confirm('Delete “' + item.name + '” and its saved job?')) return
    setBusy(item.id); setError('')
    try {
      if (remove) { await api('/api/jobs/' + item.id, { method: 'DELETE' }); onChange?.() }
      else await downloadSaved('/api/jobs/' + item.id + '/download', item.name)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The document request failed.') }
    finally { setBusy(null) }
  }

  if (!items.length) return <div className="document-empty"><span className="document-empty-icon"><FileClock size={24} strokeWidth={1.5} /></span>
    <div><strong>No documents yet</strong><p>Generated documents and PDF conversions will appear here.</p></div>
  </div>
  return <div className="activity-list">
    {error && <p className="error-box" role="alert">{error}</p>}
    {currentUserId && <div className="activity-tools">
      <label className="library-search"><Search size={16} /><span className="sr-only">Search loaded documents</span>
        <input type="search" placeholder="Search loaded documents" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="Filter documents by status" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">All statuses</option>
        {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>}
    {rows.length ? <div className="table-wrap"><table><thead><tr>
      <th scope="col">Document</th><th className="activity-type" scope="col">Format</th><th scope="col">Status</th>
      <th className="activity-date" scope="col">Created</th><th scope="col"><span className="sr-only">Document actions</span></th></tr></thead>
      <tbody>{rows.map(item => {
        const when = dates.format(new Date(item.when))
        return <tr key={item.id}>
          <td><div className="document-cell"><span className={'document-type-icon ' + item.kind.toLowerCase()}><FileText size={17} /></span>
            <div><strong>{item.name}</strong>{item.source !== item.name && <small>{item.source}</small>}
              <small className="activity-mobile-meta">{item.kind} · <time dateTime={item.when}>{when}</time></small>
              {item.error && <small className="job-error">{item.error}</small>}
            </div></div></td>
          <td className="activity-type">{item.kind}</td>
          <td><span className={'status ' + item.status}><i aria-hidden="true" />{statusLabels[item.status]}</span></td>
          <td className="activity-date"><time dateTime={item.when}>{when}</time></td>
          <td><div className="row-actions">
            {item.status === 'ready' && <button className="icon-button" disabled={busy !== null} aria-label={'Download ' + item.name}
              title="Download" onClick={() => { void act(item) }}><ArrowDownToLine size={17} /></button>}
            {onChange && item.status !== 'processing' && (item.createdBy === currentUserId || tenant.role === 'owner' || tenant.role === 'admin') &&
              <button className="icon-button" disabled={busy !== null} aria-label={'Delete ' + item.name} title="Delete"
                onClick={() => { void act(item, true) }}><Trash2 size={16} /></button>}
          </div></td>
        </tr>
      })}</tbody></table></div>
      : <div className="document-empty" role="status"><Search size={21} /><div><strong>No matching documents</strong><p>Try another name or status.</p></div>
        <button className="button secondary" onClick={() => { setQuery(''); setStatus('') }}>Clear filters</button></div>}
  </div>
}
