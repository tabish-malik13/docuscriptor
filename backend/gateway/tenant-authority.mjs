import { problem } from '../../shared/problems.mjs'

export const tenantRoles = new Set(['owner', 'admin', 'operator', 'viewer'])
export const processingRoles = new Set(['owner', 'admin', 'operator'])
export const adminRoles = new Set(['owner', 'admin'])
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createTenantAuthority({
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = fetch,
} = {}) {
  async function rest(token, resource, { method = 'GET', body } = {}) {
    if (!supabaseUrl || !publishableKey) throw problem(503, 'Supabase has not been configured.')
    let response
    try {
      response = await fetchImpl(new URL('/rest/v1/' + resource, supabaseUrl), {
        method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { apikey: publishableKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch { throw problem(503, 'Organization permissions are temporarily unavailable.') }
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const code = result?.code
      if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) {
        throw problem(503, 'The Supabase tenant schema is not installed. Apply supabase/tenant-access.sql first.')
      }
      if (response.status === 401) throw problem(401, 'Your session is invalid or expired.')
      if (code === '42501' || response.status === 403) throw problem(403, 'You do not have permission for this tenant operation.')
      if (code === 'P0002') throw problem(404, 'The tenant record was not found.')
      if (code === '23505' && result?.message?.includes('ds_tenants_slug_key')) throw problem(409, 'This workspace address is already taken. Choose another.')
      const messages = {
        '23505': 'This person is already a member.',
        '23514': 'The operation would exceed a tenant limit or remove the last owner.',
        '22023': 'Check the organization name, workspace address, email, and role.',
      }
      if (messages[code]) throw problem(code === '22023' ? 400 : 409, messages[code])
      throw problem(503, 'The tenant service could not complete the request.')
    }
    return result
  }
  const rpc = (token, name, body) => rest(token, 'rpc/' + name, { method: 'POST', body })
  return {
    async membership(token, tenantId, subject, slug) {
      const rows = await rest(token, 'ds_memberships?select=role,ds_tenants!inner(slug)&tenant_id=eq.' + tenantId + '&user_id=eq.' + subject + (slug ? '&ds_tenants.slug=eq.' + slug : ''))
      return Array.isArray(rows) && tenantRoles.has(rows[0]?.role) ? rows[0].role : null
    },
    async list(token, subject) {
      const rows = await rest(token, 'ds_memberships?select=role,ds_tenants!inner(id,name,slug)&user_id=eq.' + subject + '&order=created_at.asc')
      return rows.map((row) => ({ ...row.ds_tenants, role: row.role }))
    },
    create: (token, name, slug) => rpc(token, 'ds_create_tenant', { p_name: name, p_slug: slug }),
    rename: (token, tenantId, name) => rpc(token, 'ds_rename_tenant', { p_tenant_id: tenantId, p_name: name }),
    members: (token, tenantId) => rest(token, 'ds_memberships?select=user_id,email,role,created_at&tenant_id=eq.' + tenantId + '&order=created_at.asc'),
    invite: (token, tenantId, email, role) => rpc(token, 'ds_invite_member', { p_tenant_id: tenantId, p_email: email, p_role: role }),
    invitations: (token, tenantId, email) => rest(token, 'ds_invitations?select=id,tenant_id,tenant_name,email,role,expires_at,created_at&accepted_at=is.null&revoked_at=is.null&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) + (tenantId ? '&tenant_id=eq.' + tenantId : '') + (email ? '&email=eq.' + encodeURIComponent(email) : '') + '&order=created_at.desc'),
    accept: (token, id) => rpc(token, 'ds_accept_invitation', { p_invitation_id: id }),
    revoke: (token, tenantId, id) => rpc(token, 'ds_revoke_invitation', { p_tenant_id: tenantId, p_invitation_id: id }),
    setRole: (token, tenantId, userId, role) => rpc(token, 'ds_set_member_role', { p_tenant_id: tenantId, p_user_id: userId, p_role: role }),
    audit: (token, tenantId) => rest(token, 'ds_audit_events?select=id,actor_id,action,target_id,details,created_at&tenant_id=eq.' + tenantId + '&order=created_at.desc,id.desc&limit=50'),
  }
}
