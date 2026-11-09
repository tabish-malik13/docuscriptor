import { accessToken } from '../auth/supabase-auth'
import { download } from '../shared/download'
import { currentOrganizationSlug, workspaceConfig } from './organization-location'

export class WorkspaceRequestError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function api(path: string, options: RequestInit = {}, tenantId?: string) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', 'Bearer ' + await accessToken())
  if (tenantId) headers.set('X-Tenant-Id', tenantId)
  if (workspaceConfig.routing === 'path' && currentOrganizationSlug) headers.set('X-Organization-Slug', currentOrganizationSlug)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const processing = options.method === 'POST' && ['/api/docx/generate','/api/pdf/convert','/api/templates'].includes(path)
  const response = await fetch(path, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(processing ? 150_000 : 40_000) })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new WorkspaceRequestError(body.message || 'The workspace request failed. Try again.', response.status)
  }
  return response
}

export async function downloadSaved(path: string, name: string, tenantId?: string) {
  const response = await api(path, {}, tenantId)
  download(await response.blob(), name)
}

export function encode(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}
