export const reservedSlugs = new Set(['www','app','api','auth','admin','login','signup','register','mail','support','help','docs','status','static','assets','editor','dashboard','billing','security'])
export const organizationSlugPattern = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
export function validOrganizationSlug(slug) {
  return typeof slug === 'string' && new RegExp(organizationSlugPattern).test(slug) && !reservedSlugs.has(slug)
}
export function organizationConfig(appOrigin, baseDomain) {
  const url = new URL(appOrigin)
  const domain = baseDomain.toLowerCase()
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(domain)) throw new Error('Configure a valid application origin and organization base domain.')
  if (url.protocol === 'http:' && (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !url.hostname.endsWith('.localhost') || !domain.endsWith('.localhost'))) {
    throw new Error('Organization workspaces require HTTPS outside localhost.')
  }
  return { appOrigin: url.origin, baseDomain: domain }
}
export function organizationUrl(slug, config) {
  if (!validOrganizationSlug(slug)) throw new Error('Choose a workspace address with 3–40 lowercase letters, numbers, or hyphens.')
  const url = new URL(config.appOrigin)
  url.hostname = slug + '.' + config.baseDomain
  return url.origin + '/'
}
export function organizationSlugFromHost(host, config) {
  const hostname = new URL('http://' + host).hostname.toLowerCase()
  if (hostname === new URL(config.appOrigin).hostname || hostname === config.baseDomain) return null
  if (!hostname.endsWith('.' + config.baseDomain)) return null
  const slug = hostname.slice(0, -(config.baseDomain.length + 1))
  if (!validOrganizationSlug(slug)) throw new Error('This organization workspace address is invalid.')
  return slug
}
export function suggestOrganizationSlug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'')
}
