const settings = {
  auth: 'FEATURE_AUTH',
  apiClients: 'FEATURE_API_CLIENTS',
  whatsapp: 'FEATURE_WHATSAPP',
  billing: 'FEATURE_BILLING',
  batches: 'FEATURE_BATCHES',
  templateApiEdits: 'FEATURE_TEMPLATE_API_EDITS',
  livePreview: 'FEATURE_LIVE_PREVIEW',
  templateDeletion: 'FEATURE_TEMPLATE_DELETION',
  templateVersions: 'FEATURE_TEMPLATE_VERSIONS',
  orgCreation: 'FEATURE_ORG_CREATION',
  rateLimits: 'FEATURE_RATE_LIMITS',
}

export function gatewayFeatures(env = process.env) {
  const features = {}
  for (const [feature, setting] of Object.entries(settings)) {
    const value = env[setting] === undefined ? 'true' : env[setting]
    if (value !== 'true' && value !== 'false') throw new Error(setting + ' must be true or false.')
    features[feature] = value === 'true'
  }
  features.whatsapp &&= features.apiClients
  features.templateApiEdits &&= features.apiClients && features.templateVersions
  features.orgCreation &&= features.auth
  return Object.freeze(features)
}
