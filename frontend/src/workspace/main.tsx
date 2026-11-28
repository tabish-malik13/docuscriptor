import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../shared/base.css'
import { LandingPage } from './LandingPage'
import { currentOrganizationSlug, organizationAddressError } from './organization-location'

const WorkspaceApp = lazy(() => import('./WorkspaceApp').then(({ WorkspaceApp }) => ({ default: WorkspaceApp })))

function isProductEntry() {
  const { pathname, search, hash } = window.location
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.slice(1))
  // Organization handoffs and identity callbacks still enter the workspace directly.
  return !currentOrganizationSlug && !organizationAddressError && ['/', '/index.html'].includes(pathname) &&
    query.get('view') !== 'workspace' && !['workspace', 'code', 'error'].some(key => query.has(key)) &&
    !['access_token', 'error', 'signed-out', 'workspace-code'].some(key => fragment.has(key))
}

const productEntry = isProductEntry()
if (!productEntry) document.title = 'DocuScripter — Document workspace'
createRoot(document.getElementById('root')!).render(productEntry
  ? <LandingPage />
  : <Suspense fallback={<p role="status" className="sr-only">Opening your workspace…</p>}><WorkspaceApp /></Suspense>)
