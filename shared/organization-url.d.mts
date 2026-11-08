export type OrganizationConfig = { appOrigin: string; baseDomain: string; routing: 'path' | 'subdomain' }
export const reservedSlugs: Set<string>
export const organizationSlugPattern: string
export function validOrganizationSlug(slug: unknown): boolean
export function organizationConfig(appOrigin: string, baseDomain: string, routing?: string): OrganizationConfig
export function organizationSlugFromPath(pathname: string): string | null
export function organizationUrl(slug: string, config: OrganizationConfig): string
export function organizationSlugFromHost(host: string, config: OrganizationConfig): string | null
export function suggestOrganizationSlug(name: string): string
