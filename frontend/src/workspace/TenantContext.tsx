import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { api as baseApi, WorkspaceRequestError } from './api'
import { download } from '../shared/download'

export type TenantRole = 'owner' | 'admin' | 'operator' | 'viewer'
export type Tenant = { id: string; name: string; slug: string; role: TenantRole }
export const roleLabels: Record<TenantRole, string> = { owner: 'Organization owner', admin: 'Organization admin', operator: 'Document operator', viewer: 'Viewer' }
const Context = createContext<{ tenant: Tenant; onChange: () => void } | null>(null)

export function TenantProvider({ tenant, onChange, children }: { tenant: Tenant; onChange: () => void; children: ReactNode }) {
  const value = useMemo(() => ({ tenant, onChange }), [tenant, onChange])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useTenantApi() {
  const context = useContext(Context)
  if (!context) throw new Error('Open an organization workspace first.')
  const { tenant, onChange } = context
  return useMemo(() => {
    const api = async (path: string, options: RequestInit = {}) => {
      try { return await baseApi(path, options, tenant.id) } catch (error) {
        if (error instanceof WorkspaceRequestError && error.status === 403) onChange()
        throw error
      }
    }
    return { tenant, onChange, api,
      downloadSaved: async (path: string, name: string) => download(await (await api(path)).blob(), name),
    }
  }, [tenant, onChange])
}
