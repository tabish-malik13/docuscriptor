import { organizationConfig, organizationSlugFromHost, organizationUrl } from '../../../shared/organization-url.mjs'

export const workspaceConfig = organizationConfig(import.meta.env.VITE_APP_ORIGIN || 'http://127.0.0.1:5173', import.meta.env.VITE_ORGANIZATION_BASE_DOMAIN || 'docuscriptor.localhost')
export const currentOrganizationSlug = organizationSlugFromHost(window.location.host, workspaceConfig)
export const workspaceUrl = (slug: string) => organizationUrl(slug, workspaceConfig)
