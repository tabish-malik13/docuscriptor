import { useEffect, useState, type FormEvent } from 'react'
import { useTenantApi } from './TenantContext'
import { workspaceConfig } from './organization-location'
import { features } from '../shared/features'

export function clientPermissions(): Record<string, string> {
  return {
    'documents:convert': 'Convert DOCX or HTML to PDF',
    'documents:generate': features.batches ? 'Generate Word documents and manage batches' : 'Generate Word documents',
    'documents:read': 'Read and download organization jobs',
    'documents:delete': 'Delete jobs created by this client',
    'templates:read': 'Read and use saved organization templates',
    'templates:write': features.templateApiEdits ? 'Create templates and edit templates created by this client' : 'Create templates',
    ...(features.templateApiEdits && { 'templates:edit:organization': 'Edit any saved template in this organization' }),
    ...(features.templateDeletion && { 'templates:delete': 'Delete templates created by this client' }),
  }
}
export type Client = {
  id: string
  name: string
  scopes: string[]
  revokedAt: string | null
}
type IssuedClient = Client & { clientSecret: string }
const endpoint = '/api/tenant/clients'

export function ApiClientsPanel({ onChanged, startAdding = false }: { onChanged: () => Promise<void>; startAdding?: boolean }) {
  const { api, tenant } = useTenantApi()
  const [clients, setClients] = useState<Client[]>([])
  const [issued, setIssued] = useState<IssuedClient | null>(null)
  const [adding, setAdding] = useState(startAdding)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [revision, refreshList] = useState(0)
  const permissions = clientPermissions()

  useEffect(() => {
    let current = true
    setLoading(true)
    api(endpoint + '?offset=' + offset).then(response => response.json()).then(page => {
      if (current) { setClients(page.items); setNextOffset(page.nextOffset); setListError('') }
    }).catch(cause => {
      if (current) setListError(cause instanceof Error ? cause.message : 'Could not load API clients.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, offset, revision])

  async function change(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
      refreshList(value => value + 1)
      await onChanged().catch(() => setError('The credential change was saved. Reload to refresh the access history.'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The client could not be updated.')
    } finally { setBusy(false) }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const scopes = data.getAll('scope')
    if (!scopes.length) { setError('Choose at least one permission.'); return }
    void change(async () => {
      const response = await api(endpoint, { method: 'POST', body: JSON.stringify({ name: String(data.get('name')).trim(), scopes }) })
      setIssued(await response.json())
      setAdding(false)
      setOffset(0)
      form.reset()
    })
  }

  function rotate(client: Client) {
    if (!window.confirm('Rotate the secret for ' + client.name + '? Its current secret and access tokens will stop working immediately.')) return
    void change(async () => {
      const response = await api(endpoint + '/' + client.id + '/rotate', { method: 'POST' })
      setIssued(await response.json())
      setAdding(false)
    })
  }

  function revoke(client: Client) {
    if (!window.confirm('Revoke ' + client.name + ' and all its access tokens? This client will lose access immediately.')) return
    void change(async () => {
      await api(endpoint + '/' + client.id, { method: 'DELETE' })
      setIssued(current => current?.id === client.id ? null : current)
    })
  }

  function goToPage(value: number) {
    setClients([])
    setNextOffset(null)
    setOffset(value)
  }

  return <section className="panel workflow-form api-clients">
    <div className="section-heading"><h2>API clients</h2>
      {!issued && <button className="button secondary" disabled={busy} aria-expanded={adding} aria-controls="new-api-client"
        onClick={() => { setAdding(!adding); setError('') }}>{adding ? 'Close form' : 'New API client'}</button>}
    </div>
    <p className="form-note">Give a server application{features.whatsapp && ' or WhatsApp integration'} access to {tenant.name}. Choose the document operations it needs.</p>
    <p className="form-note">Tenant ID <code>{tenant.id}</code></p>
    {features.templateApiEdits && <details className="role-guide template-api-guide">
      <summary>Edit a template through the API</summary>
      <ol>
        <li>Grant <code>templates:read</code> and <code>templates:write</code> for the client’s own templates. To edit templates saved by other people or clients, grant <code>templates:read</code> and <code>templates:edit:organization</code>.</li>
        <li>From your server, call <code>POST {workspaceConfig.appOrigin}/api/oauth/token</code> with the client ID and secret as HTTP Basic credentials. Send <code>grant_type=client_credentials</code> as URL-encoded form data.</li>
        <li>Use the returned bearer token to call <code>GET /api/templates</code>. Use the template’s <code>id</code> and <code>version</code> to send <code>PATCH /api/templates/:id</code>.</li>
      </ol>
      <p>To rename a template, send JSON such as <code>{'{"baseVersion": 1, "name": "Service agreement"}'}</code>. To update the DOCX, send <code>baseVersion</code>, <code>filename</code> and the base64-encoded <code>file</code>. If you receive HTTP 409, fetch the latest version and review the changes before retrying.</p>
    </details>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {issued ? <div className="issued-client">
      <h3>Credentials for {issued.name}</h3>
      <p className="form-note">Save the secret in your server’s secret store. It is shown once.</p>
      <label className="field">Client ID<input readOnly value={issued.id} onFocus={event => event.target.select()} /></label>
      <label className="field">Client secret<input readOnly autoComplete="off" spellCheck={false} value={issued.clientSecret} onFocus={event => event.target.select()} /></label>
      <button className="button secondary" onClick={() => setIssued(null)}>I’ve saved the secret</button>
    </div> : adding && <form id="new-api-client" onSubmit={create}>
      <fieldset disabled={busy}><label className="field">Client name<input name="name" required maxLength={120} pattern=".*\S.*" /></label>
        <fieldset className="client-permissions"><legend>Permissions</legend>
          {Object.entries(permissions).map(([scope, label]) => <label key={scope}>
            <input type="checkbox" name="scope" value={scope} /><span>{label} <code>{scope}</code></span>
          </label>)}
        </fieldset>
        <button className="button primary">Create client</button>
      </fieldset>
    </form>}
    {listError && <p className="error-box" role="alert">{listError} <button className="button secondary" onClick={() => refreshList(value => value + 1)}>Retry</button></p>}
    {loading && !clients.length && <p role="status" className="form-note">Loading API clients…</p>}
    {!loading && !clients.length && !listError && !adding && !issued && <p className="form-note">{offset ? 'No more API clients.' : 'No API clients yet.'}</p>}
    {clients.map(client => <div className="tenant-invitation" key={client.id}>
      <div><strong>{client.name}</strong><p><code>{client.id}</code></p>
        <p>{client.scopes.filter(scope => Object.hasOwn(permissions, scope)).join(' · ') || 'No enabled permissions'}</p></div>
      {client.revokedAt ? <span>Revoked</span> : <div className="row-actions">
        <button className="button secondary" disabled={busy || !!issued} onClick={() => rotate(client)}>Rotate secret</button>
        <button className="button secondary" disabled={busy} onClick={() => revoke(client)}>Revoke</button>
      </div>}
    </div>)}
    {(offset > 0 || nextOffset !== null) && <nav className="row-actions" aria-label="API client pages">
      {offset > 0 && <button className="button secondary" onClick={() => goToPage(Math.max(0, offset - 50))}>Previous clients</button>}
      {nextOffset !== null && <button className="button secondary" onClick={() => goToPage(nextOffset)}>Next clients</button>}
    </nav>}
  </section>
}
