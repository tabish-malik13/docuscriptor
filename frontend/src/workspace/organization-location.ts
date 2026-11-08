import { organizationConfig, organizationSlugFromHost, organizationSlugFromPath, organizationUrl } from '../../../shared/organization-url.mjs'

export const workspaceConfig = organizationConfig(import.meta.env.VITE_APP_ORIGIN || 'http://127.0.0.1:5173', import.meta.env.VITE_ORGANIZATION_BASE_DOMAIN || 'docuscriptor.localhost', import.meta.env.VITE_ORGANIZATION_ROUTING || 'subdomain')
export let currentOrganizationSlug: string | null = null
export let organizationAddressError: string | null = null
try { currentOrganizationSlug = workspaceConfig.routing === 'path' ? organizationSlugFromPath(window.location.pathname) : organizationSlugFromHost(window.location.host, workspaceConfig) }
catch { organizationAddressError = 'This organization workspace address is invalid.' }
export const workspaceUrl = (slug: string) => organizationUrl(slug, workspaceConfig)
