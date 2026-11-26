const disabled = Object.freeze({
  auth: false, billing: false, apiClients: false, whatsapp: false, batches: false,
  templateApiEdits: false, livePreview: false, templateDeletion: false, templateVersions: false,
  orgCreation: false, rateLimits: false,
})

type Features = { readonly [K in keyof typeof disabled]: boolean }
export let features: Features = disabled

// Both entry points load the gateway configuration before initializing identity or rendering workspace tools.
export async function loadFeatures() {
  const response = await fetch('/api/features', {
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('Workspace settings are unavailable.')
  const result = await response.json()
  if (!result || !Object.keys(disabled).every(key => typeof result[key] === 'boolean')) {
    throw new Error('Workspace settings could not be read.')
  }
  features = Object.freeze(result as Features)
}
