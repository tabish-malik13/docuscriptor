export type OrganizationConfig = { appOrigin: string; baseDomain: string }
export const reservedSlugs: Set<string>
export const organizationSlugPattern: string
export function validOrganizationSlug(slug: unknown): boolean
export function organizationConfig(appOrigin: string, baseDomain: string): OrganizationConfig
export function organizationUrl(slug: string, config: OrganizationConfig): string
export function organizationSlugFromHost(host: string, config: OrganizationConfig): string | null
export function suggestOrganizationSlug(name: string): string
