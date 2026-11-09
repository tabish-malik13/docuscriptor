import { useRef, useState, type FormEvent } from 'react'
import { Upload } from 'lucide-react'
import { useTenantApi } from './TenantContext'

export function FileUpload({ onChange }: { onChange: () => void }) {
  const { api, tenant } = useTenantApi()
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('')
  const form = useRef<HTMLFormElement>(null)
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(busy) return
    const file = new FormData(event.currentTarget).get('file')
    if(!(file instanceof File) || !file.size || file.size>4*1024*1024 || !/\.(docx|pdf)$/i.test(file.name)) { setError('Choose a DOCX or PDF file of 4 MB or smaller.');return }
    setBusy(true);setError('');setNotice('')
    try {
      await api('/api/files', { method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file })
      form.current?.reset();setNotice('Document saved to your organization.');onChange()
    } catch(cause) {setError(cause instanceof Error?cause.message:'The upload failed. Please retry.')}
    finally {setBusy(false)}
  }
  if(tenant.role==='viewer')return <p className="form-note">You can download shared documents. An operator or administrator can upload files.</p>
  return <form ref={form} className="panel workflow-form" onSubmit={(event)=>{void upload(event)}}>
    <h2>Save a document</h2><p className="form-note">Upload a DOCX or PDF, up to 4 MB. Documents are private to your organization. Download edits from the DOCX editor, then upload the updated file here.</p>
    <fieldset disabled={busy}><label className="field">Document<input name="file" type="file" required accept=".docx,.pdf" /></label><button className="button primary"><Upload size={16}/>{busy?'Saving…':'Upload document'}</button></fieldset>
    {error&&<p className="error-box" role="alert">{error}</p>}{notice&&<p className="success-box" role="status">{notice}</p>}
  </form>
}
