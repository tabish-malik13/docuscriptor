import { createHash, randomBytes } from 'node:crypto'

export const organizationTemplateEditScope = 'templates:edit:organization'
export const clientScopes = Object.freeze([
  'documents:generate', 'documents:convert', 'documents:read', 'documents:delete',
  'templates:read', 'templates:write', organizationTemplateEditScope, 'templates:delete',
])
export const accessTokenLifetime = 900
export const newClientSecret = () => 'dss_' + randomBytes(32).toString('base64url')
export const newAccessToken = () => 'dsa_' + randomBytes(32).toString('base64url')
// Both kinds of credential have 256 bits of random entropy.
export const credentialDigest = (value) => createHash('sha256').update(value).digest()
export const isAccessToken = (value) => /^dsa_[A-Za-z0-9_-]{43}$/.test(value)
export const isClientSecret = (value) => /^dss_[A-Za-z0-9_-]{43}$/.test(value)

export function matchesClientTenant(client, request) {
  const selected = request.headers['x-tenant-id']
  return (selected === undefined || (typeof selected === 'string' && selected.toLowerCase() === client.tenantId))
    && (!request.organizationSlug || request.organizationSlug === client.slug)
}
