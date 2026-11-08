import { ArrowDownToLine, Clock3, FileText } from 'lucide-react'
import { download } from '../shared/download'
import type { Activity } from './activity'

export function ActivityTable({ items }: { items: Activity[] }) {
  if (!items.length) return <div className="empty-state"><span className="icon-chip violet"><Clock3 size={21} /></span>
    <div><strong>No activity yet</strong><p>Documents you generate or convert in this session will appear here.</p></div>
  </div>
  return <div className="table-wrap"><table><thead><tr><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Download</span></th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}>
      <td><div className="document-cell"><span className={'file-icon ' + (item.kind === 'DOCX' ? 'violet' : 'rose')}><FileText size={17} /></span>
        <div><strong>{item.name}</strong><small>{item.source}</small></div></div></td>
      <td><span className={'format ' + item.kind.toLowerCase()}>{item.kind}</span></td>
      <td><span className="status"><i /> Ready</span></td>
      <td className="date-cell">{item.when}</td>
      <td>{item.artifact && <button className="icon-button" aria-label={'Download ' + item.name} onClick={() => download(item.artifact!, item.name)}><ArrowDownToLine size={17} /></button>}</td>
    </tr>)}</tbody></table></div>
}
