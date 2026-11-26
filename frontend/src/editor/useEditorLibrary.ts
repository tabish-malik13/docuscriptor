import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { authConfigured, watchSessionUser } from '../auth/supabase-auth'
import { api, deleteSavedTemplate, encode, WorkspaceRequestError } from '../workspace/api'
import { currentOrganizationSlug, organizationAddressError, workspaceConfig, workspaceUrl } from '../workspace/organization-location'
import type { Tenant } from '../workspace/TenantContext'
import { validOrganizationSlug } from '../../../shared/organization-url.mjs'

type LibraryItem = { id: string; name: string; created: number; version: number }
type SavedTemplate = { id: string; name: string; version: number }
export type TemplateVersion = { version: number; created: string; name?: string }
type Directory = { userId: string; organizations: Tenant[]; error?: string }
type Listing = { scopeKey: string; items: LibraryItem[]; error?: string }
type Status = 'loading' | 'signed-out' | 'no-workspace' | 'ready' | 'error'

const workspaceSlug = currentOrganizationSlug ?? new URLSearchParams(location.search).get('workspace')
const invalidAddress = organizationAddressError || (workspaceSlug !== null && !validOrganizationSlug(workspaceSlug)
  ? 'This organization workspace address is invalid.' : '')

export function useEditorLibrary() {
  const [userId, setUserId] = useState<string | null | undefined>(authConfigured ? undefined : null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [selection, setSelection] = useState<{ userId: string; tenantId: string }>()
  const [listing, setListing] = useState<Listing | null>(null)
  const [refresh, setRefresh] = useState(0)
  const retry = useCallback(() => setRefresh(value => value + 1), [])

  useEffect(() => {
    let previous: string | null | undefined
    return watchSessionUser(next => {
      if (next === previous) return
      previous = next
      setDirectory(null)
      setSelection(undefined)
      setListing(null)
      setUserId(next)
    })
  }, [])
  useEffect(() => {
    if (!userId) return
    window.addEventListener('focus', retry)
    return () => window.removeEventListener('focus', retry)
  }, [userId, retry])

  useEffect(() => {
    if (!userId || invalidAddress) return
    const controller = new AbortController()
    async function load(user: string) {
      try {
        const response = await api('/api/organizations', { signal: controller.signal }, undefined, user)
        const { items }: { items: Tenant[] } = await response.json()
        const organizations = workspaceSlug ? items.filter(item => item.slug === workspaceSlug) : items
        const error = workspaceSlug && !organizations.length ? 'Your account does not have access to this organization.' : undefined
        if (!controller.signal.aborted) setDirectory({ userId: user, organizations, error })
      } catch (cause) {
        if (controller.signal.aborted) return
        const revoked = cause instanceof WorkspaceRequestError && (cause.status === 401 || cause.status === 403)
        setDirectory(previous => ({
          userId: user, organizations: !revoked && previous?.userId === user ? previous.organizations : [],
          error: cause instanceof Error ? cause.message : 'Your organizations could not be loaded.',
        }))
      }
    }
    void load(userId)
    return () => controller.abort()
  }, [userId, refresh])

  const memberships = directory && directory.userId === userId ? directory : null
  const organizations = memberships?.organizations ?? []
  const tenant = organizations.find(item => selection?.userId === userId && item.id === selection?.tenantId) ?? organizations[0]
  const tenantId = tenant?.id ?? ''
  const slug = tenant?.slug
  const scopeKey = userId && tenantId ? userId + '/' + tenantId : ''
  const activeScope = useRef<{ key: string; controller: AbortController } | null>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    activeScope.current = { key: scopeKey, controller }
    return () => controller.abort()
  }, [scopeKey])

  const request = useCallback(async (path: string, options: RequestInit = {}) => {
    const scope = activeScope.current
    if (!userId || !slug || !scope || scope.key !== scopeKey || scope.controller.signal.aborted) {
      throw new Error('Reopen your template library to continue.')
    }
    const headers = new Headers(options.headers)
    if (workspaceConfig.routing === 'path') headers.set('X-Organization-Slug', slug)
    const signal = options.signal ? AbortSignal.any([options.signal, scope.controller.signal]) : scope.controller.signal
    return api(path, { ...options, headers, signal }, tenantId, userId)
  }, [userId, tenantId, slug, scopeKey])

  useEffect(() => {
    if (!scopeKey || memberships?.error) return
    const controller = new AbortController()
    async function load() {
      try {
        const response = await request('/api/templates/mine', { signal: controller.signal })
        const { items }: { items: { id: string; name: string; created: string; version: number }[] } = await response.json()
        if (!controller.signal.aborted) setListing({ scopeKey, items: items.map(item => ({ ...item, created: Date.parse(item.created) })) })
      } catch (cause) {
        if (!controller.signal.aborted) setListing({ scopeKey, items: [], error: cause instanceof Error ? cause.message : 'Your templates could not be loaded.' })
      }
    }
    void load()
    return () => controller.abort()
  }, [scopeKey, request, refresh, memberships?.error])

  const library = listing?.scopeKey === scopeKey ? listing : null
  const error = invalidAddress || memberships?.error || library?.error || ''
  let status: Status = 'loading'
  if (error) status = 'error'
  else if (userId === null) status = 'signed-out'
  else if (memberships && !tenant) status = 'no-workspace'
  else if (library) status = 'ready'

  const listVersions = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await request('/api/templates/' + encodeURIComponent(id) + '/versions', { signal })
    const { items }: { items: TemplateVersion[] } = await response.json()
    return items
  }, [request])

  return {
    status, error, organizations, tenantId, scopeKey, items: status === 'ready' ? library!.items : [],
    canSave: status === 'ready' && !!tenant && tenant.role !== 'viewer',
    workspaceHref: workspaceSlug && !invalidAddress ? workspaceUrl(workspaceSlug) : workspaceConfig.appOrigin,
    retry, listVersions,
    selectTenant(id: string) {
      if (userId && organizations.some(item => item.id === id)) setSelection({ userId, tenantId: id })
    },
    async openTemplate(id: string) {
      const response = await request('/api/templates/mine/' + encodeURIComponent(id) + '/download')
      // Bind edits to the version of these bytes, even if the sidebar refreshed during download.
      const version = Number(response.headers.get('X-Template-Version'))
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('The template version could not be verified. Reopen the template to try again.')
      return { source: new Uint8Array(await response.arrayBuffer()), version }
    },
    async downloadVersion(id: string, version: number, signal: AbortSignal) {
      const response = await request('/api/templates/' + encodeURIComponent(id) + '/versions/' + version + '/download', { signal })
      return response.blob()
    },
    async deleteTemplate(id: string) {
      try {
        await deleteSavedTemplate(request, id)
        setListing(previous => previous?.scopeKey === scopeKey
          ? { ...previous, items: previous.items.filter(item => item.id !== id) } : previous)
      } finally {
        retry()
      }
    },
    async saveTemplate(name: string, bytes: ArrayBuffer, existing?: { id: string; version: number }) {
      const filename = name.replace(/\.docx$/i, '') + '.docx'
      const file = await encode(new File([bytes], filename))
      const path = existing ? '/api/templates/' + encodeURIComponent(existing.id) + '/versions' : '/api/templates'
      const body = existing ? { filename, file, baseVersion: existing.version } : { name, filename, file }
      try {
        const response = await request(path, { method: 'POST', body: JSON.stringify(body) })
        return await response.json() as SavedTemplate
      } finally {
        retry()
      }
    },
  }
}
