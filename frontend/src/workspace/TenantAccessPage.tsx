import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTenantApi, type TenantRole } from './TenantContext'

type Member = { user_id: string; email: string; role: TenantRole }
type Invitation = { id: string; email: string; role: string; expires_at: string }
type Audit = { id: number; action: string; actor_id: string; target_id: string | null; created_at: string }

export function TenantAccessPage() {
  const { api, tenant, onChange } = useTenantApi()
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [audit, setAudit] = useState<Audit[]>([])
  const [legacy, setLegacy] = useState({ jobs: 0, templates: 0 })
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    const [people, pending, events, personal] = await Promise.all([
      api('/api/tenant/members').then((r) => r.json()) as Promise<{ items: Member[] }>,
      api('/api/tenant/invitations').then((r) => r.json()) as Promise<{ items: Invitation[] }>,
      api('/api/tenant/audit').then((r) => r.json()) as Promise<{ items: Audit[] }>,
      api('/api/personal-records').then((r) => r.json()) as Promise<{ jobs: number; templates: number }>,
    ])
    setMembers(people.items); setInvitations(pending.items); setAudit(events.items); setLegacy(personal)
  }, [api])
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Tenant settings could not be loaded.')).finally(() => setLoading(false))
  }, [load])
  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work(); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Tenant change failed.') }
    finally { setBusy(false); onChange() }
  }
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, data = new FormData(form)
    void run(async () => {
      await api('/api/tenant/invitations', { method: 'POST', body: JSON.stringify({ email: String(data.get('email')).trim(), role: data.get('role') }) })
      form.reset(); setNotice('Invitation saved. Ask this person to sign in with that verified email and accept it. No invitation email was sent.')
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
    {loading && <p role="status">Loading tenant administration…</p>}
    <form className="panel workflow-form" onSubmit={rename}>
      <fieldset disabled={busy || loading}><label className="field">Organization name<input name="name" key={tenant.name} defaultValue={tenant.name} required maxLength={120} /></label><button className="button secondary">Save name</button></fieldset>
    </form>
    <form className="panel workflow-form" onSubmit={invite}>
      <h2>Invite a member</h2><p className="form-note">An invitation lasts seven days and can only be accepted by its verified email recipient.</p>
      <fieldset disabled={busy || loading}>
        <label className="field">Email<input name="email" type="email" required maxLength={254} /></label>
        <label className="field">Role<select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="operator">Document operator</option><option value="admin">Organization admin</option></select></label>
        <button className="button primary">Create invitation</button>
      </fieldset>
    </form>
    <section className="panel workflow-form"><h2>Members</h2><p className="form-note">Viewers read shared documents. Operators process documents and manage their own uploads. Admins manage organization content and people. Owners also manage ownership. At least one owner must remain.</p>
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
    {tenant.role === 'owner' && legacy.jobs + legacy.templates > 0 && <section className="panel workflow-form"><h2>Import your prior personal records</h2>
      <p className="form-note">You have {legacy.jobs} personal jobs and {legacy.templates} personal templates from before tenant support. Importing them shares their contents with all members of {tenant.name}.</p>
      <button className="button secondary" disabled={busy} onClick={() => {
        if (window.confirm('Share all your prior personal documents and templates with every member of ' + tenant.name + '?')) void run(async () => {
          await api('/api/tenant/import-personal', { method: 'POST', body: JSON.stringify({ shareWithTenant: true }) }); setNotice('Your personal records were imported into this organization.')
        })
      }}>Import and share with organization</button>
    </section>}
    <section className="panel workflow-form"><h2>Recent access changes</h2><div className="table-wrap"><table><thead><tr><th>Change</th><th>Actor</th><th>When</th></tr></thead><tbody>{audit.map((event) => <tr key={event.id}><td>{event.action}</td><td>{members.find((member) => member.user_id === event.actor_id)?.email || event.actor_id || 'Deleted account'}</td><td>{new Date(event.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>{!audit.length && <p className="form-note">No access changes recorded.</p>}</section>
  </div>
}
