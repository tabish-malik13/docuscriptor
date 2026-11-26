import { readFileSync } from 'node:fs'
import { defaultWorkspaceLimits } from '../gateway/store.mjs'
import { uuidPattern } from '../gateway/tenant-authority.mjs'

const gibibyte = 1024 ** 3
const paidDefaults = {
  plus: { storageBytes: gibibyte, savedTemplates: 250, retainedJobs: 5000 },
  ultimate: { storageBytes: 5 * gibibyte, savedTemplates: 1000, retainedJobs: 25000 },
}

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (keys && Object.keys(value).some(key => !keys.includes(key)))) {
    throw new Error('Invalid ' + label + ' in BILLING_LICENSES_FILE.')
  }
  return value
}

export function createLicenseCatalog(env = process.env) {
  let config = {}
  if (env.BILLING_LICENSES_FILE) {
    let parsed
    try { parsed = JSON.parse(readFileSync(env.BILLING_LICENSES_FILE, 'utf8')) }
    catch { throw new Error('BILLING_LICENSES_FILE must point to a readable JSON file.') }
    config = objectWithKeys(parsed, ['plans', 'licenses'], 'catalog')
  }
  const custom = objectWithKeys(Object.hasOwn(config, 'plans') ? config.plans : {}, Object.keys(paidDefaults), 'plans')
  const tiers = new Map([['self-hosted', defaultWorkspaceLimits], ['starter', defaultWorkspaceLimits]])
  const plans = Object.entries(paidDefaults).map(([id, defaults]) => {
    const overrides = objectWithKeys(Object.hasOwn(custom, id) ? custom[id] : {}, Object.keys(defaults), id + ' limits')
    const limits = Object.freeze({ ...defaults, ...overrides })
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Plan limits in BILLING_LICENSES_FILE must be positive whole numbers.')
    }
    tiers.set(id, limits)
    return { id, name: id === 'plus' ? 'Plus' : 'Ultimate', limits }
  })
  const licenses = new Map()
  for (const [id, entry] of Object.entries(objectWithKeys(Object.hasOwn(config, 'licenses') ? config.licenses : {}, null, 'licenses'))) {
    objectWithKeys(entry, ['plan', 'expiresAt'], 'license')
    const key = id.toLowerCase()
    if (!uuidPattern.test(id) || licenses.has(key) || typeof entry.plan !== 'string' || !Object.hasOwn(paidDefaults, entry.plan)) {
      throw new Error('Use a unique organization UUID and a Plus or Ultimate plan ID for each license.')
    }
    let expires = Infinity
    if (entry.expiresAt !== undefined) {
      const iso = entry.expiresAt
      expires = typeof iso === 'string' ? Date.parse(iso) : NaN
      const canonical = Number.isFinite(expires) ? new Date(expires).toISOString() : ''
      if (!canonical || (canonical !== iso && canonical.replace('.000Z', 'Z') !== iso)) {
        throw new Error('License expiresAt must be a UTC timestamp such as 2027-06-01T00:00:00Z.')
      }
    }
    licenses.set(key, { plan: entry.plan, expires })
  }
  return {
    plans,
    limits(plan) {
      const limits = tiers.get(plan)
      if (!limits) throw new Error('Unknown workspace license.')
      return limits
    },
    manualPlan(tenantId, nowMs = Date.now()) {
      const license = licenses.get(tenantId.toLowerCase())
      return license && nowMs < license.expires ? license.plan : null
    },
  }
}
