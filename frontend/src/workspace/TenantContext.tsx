import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { api as baseApi, WorkspaceRequestError } from './api'
import { download } from '../shared/download'

export type TenantRole = 'owner' | 'admin' | 'operator' | 'viewer'
export type Tenant = { id: string; name: string; slug: string; role: TenantRole }
export const roleLabels: Record<TenantRole, string> = { owner: 'Organization owner', admin: 'Organization admin', operator: 'Document operator', viewer: 'Viewer' }
type TenantContext = { tenant: Tenant; userId: string; onChange: () => void; getScopeSignal: () => AbortSignal }
const Context = createContext<TenantContext | null>(null)

export function TenantProvider({ tenant, userId, onChange, children }: Omit<TenantContext, 'getScopeSignal'> & { children: ReactNode }) {
  const scope = useRef(new AbortController())
  useLayoutEffect(() => {
    scope.current = new AbortController()
    return () => scope.current.abort()
  }, [])
  const value = useMemo(() => ({ tenant, userId, onChange, getScopeSignal: () => scope.current.signal }), [tenant, userId, onChange])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useTenantApi() {
  const context = useContext(Context)
  if (!context) throw new Error('Open an organization workspace first.')
  const { tenant, userId, onChange, getScopeSignal } = context
  return useMemo(() => {
    const api = async (path: string, options: RequestInit = {}) => {
      const scope = getScopeSignal()
      const signal = options.signal ? AbortSignal.any([scope, options.signal]) : scope
      try { return await baseApi(path, { ...options, signal }, tenant.id, userId) } catch (error) {
        if (error instanceof WorkspaceRequestError && error.status === 403) onChange()
        throw error
      }
    }
    return { tenant, onChange, api,
      downloadSaved: async (path: string, name: string) => download(await (await api(path)).blob(), name),
    }
  }, [tenant, userId, onChange, getScopeSignal])
}
