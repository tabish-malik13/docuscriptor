import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTenantApi, type TenantRole } from './TenantContext'
import { ApiClientsPanel } from './ApiClientsPanel'
import { WhatsAppPanel } from './WhatsAppPanel'
import { features } from '../shared/features'

type Member = { user_id: string; email: string; role: TenantRole }
type Invitation = { id: string; email: string; role: string; expires_at: string }
type Audit = { id: number | string; action: string; actor_id: string | null; target_id: string | null; created_at: string }
const clientActions: Record<string, string> = {
  'client.created': 'API client created',
  'client.rotated': 'Client secret rotated',
  'client.revoked': 'API client revoked',
}

export function TenantAccessPage() {
  const { api, tenant, onChange } = useTenantApi()
  const [section, setSection] = useState<'people' | 'clients' | 'whatsapp' | 'history' | 'general'>('people')
  const [clientFormRequest, requestClientForm] = useState(0)
  const [inviting, setInviting] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [audit, setAudit] = useState<Audit[]>([])
  const [legacy, setLegacy] = useState({ jobs: 0, templates: 0 })
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refreshAudit = useCallback(async () => {
    const page = await (await api('/api/tenant/audit')).json() as { items: Audit[] }
    setAudit(page.items)
  }, [api])
  const load = useCallback(async () => {
    const [people, pending, personal] = await Promise.all([
      api('/api/tenant/members').then((r) => r.json()) as Promise<{ items: Member[] }>,
      api('/api/tenant/invitations').then((r) => r.json()) as Promise<{ items: Invitation[] }>,
      api('/api/personal-records').then((r) => r.json()) as Promise<{ jobs: number; templates: number }>,
      refreshAudit(),
    ])
    setMembers(people.items); setInvitations(pending.items); setLegacy(personal)
  }, [api, refreshAudit])
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Organization settings could not be loaded.')).finally(() => setLoading(false))
  }, [load])
  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work(); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Organization change failed.') }
    finally { setBusy(false); onChange() }
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, data = new FormData(form)
    void run(async () => {
      await api('/api/tenant/invitations', { method: 'POST', body: JSON.stringify({ email: String(data.get('email')).trim(), role: data.get('role') }) })
      form.reset(); setInviting(false); setNotice('Invitation saved. Ask this person to sign in with that verified email and accept it. No invitation email was sent.')
    })
  }
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name')).trim()
    void run(async () => { await api('/api/tenant', { method: 'PATCH', body: JSON.stringify({ name }) }); setNotice('Organization name updated.') })
  }
  return <div className="tenant-settings">
    {error && <p className="error-box" role="alert">{error} <button className="button secondary" onClick={() => { void run(async () => {}) }}>Retry</button></p>}
    {notice && <p className="success-box" role="status">{notice}</p>}
    {loading && <p role="status">Loading organization settings…</p>}
    <nav className="settings-nav" aria-label="Organization settings sections">
      {([['people', 'People'], ['clients', 'API clients'], ['whatsapp', 'WhatsApp'], ['history', 'Access history'], ['general', 'General']] as const)
        .filter(([id]) => (id !== 'clients' || features.apiClients) && (id !== 'whatsapp' || features.whatsapp)).map(([id, label]) =>
        <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}
    </nav>
    <div className="settings-stack" hidden={section !== 'people'}>
      <section className="panel workflow-form">
        <div className="section-heading"><h2>Members</h2>
          <button className="button secondary" aria-expanded={inviting} aria-controls="member-invite" onClick={() => setInviting(!inviting)}>{inviting ? 'Close invitation' : 'Invite a member'}</button>
        </div>
        {inviting && <form id="member-invite" className="invite-form" onSubmit={invite}>
          <p className="form-note">An invitation lasts seven days and can only be accepted by its verified email recipient.</p>
          <fieldset disabled={busy || loading}>
            <label className="field">Email<input name="email" type="email" required maxLength={254} /></label>
            <label className="field">Role<select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="operator">Document operator</option><option value="admin">Organization admin</option></select></label>
            <button className="button primary">Create invitation</button>
          </fieldset>
        </form>}
        <details className="role-guide"><summary>Organization roles</summary><p className="form-note">Viewers read shared documents. Operators process documents and manage their own uploads. Admins manage content and people. Owners also manage ownership. Each organization needs at least one owner.</p></details>
        <div className="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Access</th></tr></thead><tbody>{members.map((member) => <tr key={member.user_id}>
          <td>{member.email}</td><td><select aria-label={'Role for ' + member.email} value={member.role} disabled={busy || (member.role === 'owner' && tenant.role !== 'owner')} onChange={(event) => {
            const role = event.target.value
            void run(async () => { await api('/api/tenant/members/' + member.user_id, { method: 'PATCH', body: JSON.stringify({ role }) }) })
          }}>
            {(tenant.role === 'owner' || member.role === 'owner') && <option value="owner">Owner</option>}
            <option value="admin">Admin</option><option value="operator">Operator</option><option value="viewer">Viewer</option>
          </select></td>
          <td><button className="button secondary" disabled={busy || (member.role === 'owner' && tenant.role !== 'owner')} onClick={() => {
            if (window.confirm('Remove this person from the organization? Their previously created organization documents will remain.')) void run(async () => {
              await api('/api/tenant/members/' + member.user_id, { method: 'DELETE' })
            })
          }}>Remove</button></td>
        </tr>)}</tbody></table></div>
      </section>
      <section className="panel workflow-form"><h2>Pending invitations</h2>{invitations.length ? invitations.map((invitation) => <div className="tenant-invitation" key={invitation.id}>
        <div><strong>{invitation.email}</strong><p>{invitation.role} · Expires {new Date(invitation.expires_at).toLocaleDateString()}</p></div>
        <button className="button secondary" disabled={busy} onClick={() => { void run(async () => { await api('/api/tenant/invitations/' + invitation.id, { method: 'DELETE' }) }) }}>Revoke</button>
      </div>) : <p className="form-note">No pending invitations.</p>}</section>
    </div>
    {features.apiClients && <div hidden={section !== 'clients'}><ApiClientsPanel key={clientFormRequest} onChanged={refreshAudit} startAdding={clientFormRequest > 0} /></div>}
    {features.whatsapp && section === 'whatsapp' && <WhatsAppPanel createClient={() => { requestClientForm(value => value + 1); setSection('clients') }} />}
    <div className="settings-stack" hidden={section !== 'general'}>
      <form className="panel workflow-form" onSubmit={rename}>
        <h2>Organization details</h2>
        <fieldset disabled={busy || loading}><label className="field">Organization name<input name="name" key={tenant.name} defaultValue={tenant.name} required maxLength={120} /></label><button className="button secondary">Save name</button></fieldset>
      </form>
      {tenant.role === 'owner' && legacy.jobs + legacy.templates > 0 && <section className="panel workflow-form"><h2>Import your prior personal records</h2>
        <p className="form-note">You have {legacy.jobs} personal jobs and {legacy.templates} personal templates from before organizations were introduced. Importing them shares their contents with all members of {tenant.name}.</p>
        <button className="button secondary" disabled={busy} onClick={() => {
          if (window.confirm('Share all your prior personal documents and templates with every member of ' + tenant.name + '?')) void run(async () => {
            await api('/api/tenant/import-personal', { method: 'POST', body: JSON.stringify({ shareWithTenant: true }) }); setNotice('Your personal records were imported into this organization.')
          })
        }}>Import and share with organization</button>
      </section>}
    </div>
    <section className="panel workflow-form" hidden={section !== 'history'}><h2>Recent access changes</h2>
      <div className="table-wrap"><table><thead><tr><th>Change</th><th>Actor</th><th>When</th></tr></thead>
        <tbody>{audit.map(event => <tr key={event.id}>
          <td>{clientActions[event.action] || event.action}
            {clientActions[event.action] && event.target_id && <p><code>{event.target_id}</code></p>}
          </td>
          <td>{members.find(member => member.user_id === event.actor_id)?.email || event.actor_id || 'Deleted account'}</td>
          <td>{new Date(event.created_at).toLocaleString()}</td>
        </tr>)}</tbody>
      </table></div>
      {!audit.length && <p className="form-note">No access changes recorded.</p>}
    </section>
  </div>
}
