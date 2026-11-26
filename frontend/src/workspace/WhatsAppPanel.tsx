import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, ExternalLink, MessageCircle, RefreshCw } from 'lucide-react'
import { clientPermissions, type Client } from './ApiClientsPanel'
import { useTenantApi } from './TenantContext'
import './whatsapp.css'

const endpoint = '/api/tenant/whatsapp'
type ActiveClient = Pick<Client, 'id' | 'name' | 'scopes'>
type Settings = { version: string; phoneNumberId: string; clientId: string; senders: string[] }
type Connection = Settings & { id: string; revision: string; callbackUrl: string; verifiedAt: string | null; deploymentConflict: boolean; clientCredentialValid: boolean }
type Snapshot = { connection: Connection | null; clients: ActiveClient[]; deploymentManagedNumbers: number }
type Changes = Settings & { appSecret?: string; accessToken?: string; clientSecret?: string; rotateVerifyToken?: boolean }
type FormProps = { connection: Connection | null; clients: ActiveClient[]; busy: boolean; onSave: (changes: Changes) => void; onCancel: () => void }

function permissionLabels(client: ActiveClient) {
  const labels = clientPermissions()
  return client.scopes.filter(scope => Object.hasOwn(labels, scope)).map(scope => labels[scope]).join(' · ') || 'No enabled permissions'
}

function ConnectionForm({ connection, clients, busy, onSave, onCancel }: FormProps) {
  const [clientId, setClientId] = useState(connection && clients.some(item => item.id === connection.clientId) ? connection.clientId : clients.length === 1 ? clients[0].id : '')
  const [error, setError] = useState('')
  const selected = clients.find(client => client.id === clientId)
  const needsClientSecret = connection?.clientId !== clientId || connection?.clientCredentialValid === false
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const senders = String(data.get('senders')).split('\n').map(value => value.trim()).filter(Boolean)
    if (!senders.length || senders.length > 250) { setError('Enter between 1 and 250 senders, one per line.'); return }
    if (senders.some(value => !/^(?:[1-9]\d{5,14}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$/.test(value))) {
      setError('Use international phone numbers with digits only, or exact business-scoped user IDs, one per line.'); return
    }
    if (new Set(senders).size !== senders.length) { setError('Remove duplicate entries from allowed senders.'); return }
    setError('')
    const changes: Changes = { phoneNumberId: String(data.get('phoneNumberId')).trim(), version: String(data.get('version')).trim(), clientId, senders }
    for (const key of ['appSecret', 'accessToken', 'clientSecret'] as const) {
      const value = String(data.get(key) ?? '').trim()
      if (value) changes[key] = value
    }
    onSave(changes)
  }
  const keep = connection ? 'Leave blank to keep the saved value' : undefined
  return <form className="wa-form" onSubmit={submit}>
    <fieldset disabled={busy}>
      <div className="wa-group"><h3>Meta business account</h3>
        <p className="form-note">Use a Meta app dedicated to this organization. Find the number ID and Graph API version in its WhatsApp API setup.</p>
        <div className="field-grid">
          <label className="field">Business phone number ID<input name="phoneNumberId" required inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} defaultValue={connection?.phoneNumberId} /></label>
          <label className="field">Graph API version<input name="version" required pattern={'v[1-9][0-9]{0,2}\\.[0-9]{1,2}'} defaultValue={connection?.version ?? ''} placeholder="v27.0" /></label>
          <label className="field">Meta app secret<input type="password" name="appSecret" autoComplete="new-password" required={!connection} minLength={24} maxLength={8192} placeholder={keep} /></label>
          <label className="field">System-user access token<input type="password" name="accessToken" autoComplete="new-password" required={!connection} minLength={24} maxLength={8192} placeholder={keep} /></label>
        </div>
      </div>
      <div className="wa-group"><h3>Workspace access</h3>
        <p className="form-note">Every allowed sender can use the permissions of the selected API client.</p>
        <div className="field-grid">
          <label className="field">Organization API client<select required value={clientId} onChange={event => setClientId(event.target.value)}>
            <option disabled value="">Choose an API client</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select></label>
          <label className="field">API client secret<input type="password" name="clientSecret" key={clientId} autoComplete="new-password"
            required={needsClientSecret} pattern={'dss_[A-Za-z0-9_\\-]{43}'} placeholder={needsClientSecret ? undefined : keep} /></label>
        </div>
        {selected && <p className="wa-permissions"><strong>Client permissions</strong>{permissionLabels(selected)}</p>}
        <label className="field">Allowed senders<textarea name="senders" required rows={3} defaultValue={connection?.senders.join('\n')} spellCheck={false} />
          <span className="field-hint">One consenting sender per line. Use international phone numbers with digits only or Meta business-scoped user IDs.</span>
        </label>
      </div>
      {error && <p role="alert" className="error-box">{error}</p>}
      <div className="wa-actions"><button className="button primary">{busy ? 'Saving…' : connection ? 'Save changes' : 'Save connection'}</button>
        <button className="button secondary" type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>
}

function CopyField({ label, value }: { label: string; value: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState('')
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('Copied') }
    catch { input.current?.focus(); input.current?.select(); setMessage('Text selected. Use your copy shortcut.') }
  }
  return <div className="wa-copy"><label className="field">{label}<input ref={input} value={value} readOnly spellCheck={false} autoComplete="off" onFocus={e => e.target.select()} /></label>
    <button type="button" className="button secondary" aria-label={'Copy ' + label.toLowerCase()} onClick={() => void copy()}><Copy size={15} />Copy</button>
    {message && <small role="status">{message}</small>}</div>
}

export function WhatsAppPanel({ createClient }: { createClient: () => void }) {
  const { api, tenant } = useTenantApi()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [form, setForm] = useState<{ connection: Connection | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [issued, setIssued] = useState<{ revision: string; token: string } | null>(null)
  const [refresh, requestRefresh] = useState(0)
  const operation = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError('')
    api(endpoint, { signal: controller.signal }).then(r => r.json()).then((result: Snapshot) => {
      if (!controller.signal.aborted) setSnapshot(result)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load WhatsApp settings.')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [api, refresh])
  useEffect(() => () => operation.current?.abort(), [])
  const connection = snapshot?.connection
  const verifyToken = connection && issued?.revision === connection.revision ? issued.token : ''
  const callback = connection ? new URL(connection.callbackUrl) : null
  const needsPublicOrigin = callback && (callback.protocol !== 'https:' || /(^|\.)localhost$|^127\.|^\[::1\]$/.test(callback.hostname))
  const client = snapshot?.clients.find(item => item.id === connection?.clientId)

  function reload() {
    setForm(null); setNotice(''); setIssued(null); requestRefresh(value => value + 1)
  }
  async function change(changes: Changes | null, revision = connection?.revision ?? null) {
    if (busy || operation.current || !snapshot) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      if (changes) {
        const response = await api(endpoint, { method: 'PUT', signal: controller.signal, body: JSON.stringify({ ...changes, revision }) })
        const result: { connection: Connection; verifyToken?: string } = await response.json()
        if (!controller.signal.aborted) {
          setSnapshot({ ...snapshot, connection: result.connection })
          setIssued(result.verifyToken ? { revision: result.connection.revision, token: result.verifyToken } : null)
          setNotice(changes.rotateVerifyToken ? 'Verification token replaced.' : 'WhatsApp connection saved.')
        }
      } else if (connection) {
        await api(endpoint + '?revision=' + encodeURIComponent(connection.revision), { method: 'DELETE', signal: controller.signal })
        if (!controller.signal.aborted) { setSnapshot({ ...snapshot, connection: null }); setIssued(null); setNotice('WhatsApp disconnected.') }
      }
      if (!controller.signal.aborted) setForm(null)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not update this connection.')
    } finally { if (!controller.signal.aborted) setBusy(false); operation.current = null }
  }
  function rotate() {
    if (connection && window.confirm('Replace the verification token? Use the new token the next time you verify this callback in Meta.')) {
      const { phoneNumberId, version, clientId, senders } = connection
      void change({ phoneNumberId, version, clientId, senders, rotateVerifyToken: true })
    }
  }
  return <section className="panel workflow-form wa-panel" aria-labelledby="wa-heading">
    <div className="wa-heading"><span className="wa-mark" aria-hidden="true"><MessageCircle size={22} /></span><div><h2 id="wa-heading">WhatsApp Business</h2>
      <p className="form-note">Generate documents and convert Word files from an authorized WhatsApp chat.</p></div></div>
    {error && <div className="error-box" role="alert">{error} <button type="button" className="button secondary" disabled={busy} onClick={reload}>Reload settings</button></div>}
    {notice && <p className="success-box" role="status">{notice}</p>}
    {!snapshot && busy && <p className="form-note" role="status">Loading WhatsApp settings…</p>}
    {!!snapshot?.deploymentManagedNumbers && <p className="wa-operator-note">Your deployment administrator manages {snapshot.deploymentManagedNumbers === 1 ? 'one WhatsApp number' : snapshot.deploymentManagedNumbers + ' WhatsApp numbers'} for this organization. Contact them to change that configuration.</p>}
    {connection?.deploymentConflict && <p className="error-box" role="alert">This callback is disabled because the deployment configuration also uses its business number or Meta app. Update this connection or ask your deployment administrator to resolve the conflict.</p>}
    {snapshot && (form ? <ConnectionForm connection={form.connection} clients={snapshot.clients} busy={busy}
      onSave={changes => void change(changes, form.connection?.revision ?? null)} onCancel={() => { setForm(null); setError('') }} />
      : connection ? <>
        <div className="wa-group">
          <div className="section-heading"><h3>Connection details</h3>
            {snapshot.clients.length > 0 && <button className="button secondary" disabled={busy} onClick={() => { setForm({ connection }); setNotice(''); setIssued(null) }}>Edit connection</button>}
          </div>
          <dl className="wa-details">
            <div><dt>Business phone number ID</dt><dd>{connection.phoneNumberId}</dd></div><div><dt>Graph API version</dt><dd>{connection.version}</dd></div>
            <div><dt>Organization API client</dt><dd>{client?.name ?? 'Client is unavailable'}</dd></div>
            <div><dt>Allowed senders</dt><dd>{connection.senders.join(', ')}</dd></div>
          </dl>
          {client && <p className="wa-permissions"><strong>Client permissions</strong>{permissionLabels(client)}</p>}
          {client && connection.clientCredentialValid === false && <p className="error-box" role="alert">The API client secret has changed. Edit this connection and enter its current secret to restore document commands.</p>}
          {!client && <p className="form-note" role="status">This connection needs an active API client. {snapshot.clients.length ? 'Edit the connection to select one.' : <button className="text-button" onClick={createClient}>Create an API client</button>}</p>}
        </div>
        <div className="wa-group wa-webhook"><div className="section-heading"><h3>Meta webhook</h3>
          <button className="button secondary" disabled={busy} onClick={() => { setNotice(''); requestRefresh(v => v + 1) }}><RefreshCw size={14} />Check status</button></div>
          <p className="form-note" role="status">{connection.deploymentConflict ? 'Webhook disabled by deployment configuration.' : connection.verifiedAt ? 'Webhook verified on ' + new Date(connection.verifiedAt).toLocaleString() + '.' : 'Awaiting webhook verification.'}</p>
          <CopyField label="Callback URL" value={connection.callbackUrl} />
          {needsPublicOrigin && <p className="wa-hint">Meta needs a public HTTPS callback. Ask your deployment administrator to configure the public application origin.</p>}
          {verifyToken && <div className="issued-client wa-issued"><CopyField key={verifyToken} label="Verification token" value={verifyToken} />
            <p className="form-note">Copy this one-time token into Meta before leaving this page.</p>
            <button type="button" className="button secondary" onClick={() => setIssued(null)}>Hide token</button></div>}
          <p className="form-note">In your Meta app, enter the callback URL and verification token, subscribe your app to the WhatsApp Business Account and enable the <code>messages</code> field. Send <code>help</code> from an allowed number to check delivery.</p>
          <div className="wa-actions"><a className="button secondary" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Open Meta dashboard <ExternalLink size={14} /></a>
            {!verifyToken && <button className="text-button" disabled={busy || !client || connection.clientCredentialValid === false || connection.deploymentConflict} onClick={rotate}>Replace verification token</button>}</div>
        </div>
        <button className="button wa-disconnect" disabled={busy} onClick={() => { if (window.confirm('Disconnect WhatsApp from ' + tenant.name + '? This callback will stop accepting messages.')) void change(null) }}>Disconnect WhatsApp</button>
      </> : <div className="wa-group wa-empty"><h3>Connect your business number</h3>
        <p className="form-note">{snapshot.clients.length ? 'Have your Meta app secret, system-user access token, phone number ID and a workspace API client secret ready.' : 'First create an organization API client. Choose the document permissions your WhatsApp senders need and save the client secret, then return here.'}</p>
        <button className="button primary" disabled={busy} onClick={snapshot.clients.length ? () => { setForm({ connection: null }); setNotice('') } : createClient}>{snapshot.clients.length ? 'Set up WhatsApp' : 'Create an API client'}</button>
      </div>)}
  </section>
}
