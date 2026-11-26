import { accessToken, recheckBrowserSession } from '../auth/supabase-auth'
import { download } from '../shared/download'
import { currentOrganizationSlug, workspaceConfig } from './organization-location'

export class WorkspaceRequestError extends Error {
  constructor(message: string, public status: number, public retryAfter: number | null = null) { super(message) }
}

export async function api(path: string, options: RequestInit = {}, tenantId?: string, expectedUserId?: string) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', 'Bearer ' + await accessToken(expectedUserId))
  if (tenantId) headers.set('X-Tenant-Id', tenantId)
  if (workspaceConfig.routing === 'path' && currentOrganizationSlug) headers.set('X-Organization-Slug', currentOrganizationSlug)
  if (options.body) headers.set('Content-Type', 'application/json')
  // A batch PDF row can run both private services in sequence.
  const timeout = /^\/api\/batches\/[^/]+\/next(?:\?|$)/.test(path) ? 95_000 : 40_000
  const deadline = AbortSignal.timeout(timeout)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const response = await fetch(path, { ...options, headers, signal })
  if (!response.ok) {
    if (response.status === 401) recheckBrowserSession()
    const body = await response.json().catch(() => ({}))
    const delay = response.headers.get('Retry-After')
    const retryAfter = delay !== null && /^\d+$/.test(delay) ? Number(delay) : null
    throw new WorkspaceRequestError(body.message || 'The workspace request failed. Try again.', response.status, retryAfter)
  }
  return response
}

export async function downloadSaved(path: string, name: string, tenantId?: string) {
  const response = await api(path, {}, tenantId)
  download(await response.blob(), name)
}

export async function deleteSavedTemplate(request: (path: string, options: RequestInit) => Promise<Response>, id: string) {
  try {
    await request('/api/templates/' + encodeURIComponent(id), { method: 'DELETE' })
  } catch (cause) {
    // Another member may already have removed this template.
    if (!(cause instanceof WorkspaceRequestError) || cause.status !== 404) throw cause
  }
}

export function encode(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}
