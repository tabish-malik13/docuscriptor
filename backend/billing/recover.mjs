import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { uuidPattern } from '../gateway/tenant-authority.mjs'
import { openBillingStore } from './store.mjs'

export function recoverBilling(args, env = process.env) {
  const { positionals: [action, ...rest], values } = parseArgs({ args, allowPositionals: true, options: {
    tenant: { type: 'string' }, provider: { type: 'string' }, attempt: { type: 'string' },
    reason: { type: 'string' }, 'confirmed-absent': { type: 'boolean' },
  } })
  const tenant = values.tenant?.toLowerCase(), provider = values.provider
  if (!['show','release'].includes(action) || rest.length || !uuidPattern.test(tenant) || !['stripe','razorpay'].includes(provider)) {
    throw new Error('Choose show or release and provide --tenant <organization UUID> --provider stripe|razorpay.')
  }
  const workspace = env.DATA_PATH || fileURLToPath(new URL('../../.data/workspace.sqlite', import.meta.url))
  const path = workspace + '.billing.sqlite'
  if (!existsSync(path)) throw new Error('No billing database exists alongside DATA_PATH.')
  const db = openBillingStore(path)
  try {
    const row = db.current(tenant)
    if (row?.phase !== 'creating' || row.provider !== provider || row.checkout_id || row.subscription_id) {
      throw new Error('There is no unconfirmed creation for this organization and provider.')
    }
    if (action === 'show') return { attempt: row.id, tenant, provider, plan: row.plan, created: new Date(row.created_at).toISOString() }
    const reason = values.reason?.trim()
    if (!values['confirmed-absent'] || row.id !== values.attempt || !reason || reason.length > 500) {
      throw new Error('Release requires the matching --attempt, --confirmed-absent and a --reason of 1 to 500 characters.')
    }
    if (!db.releaseUnconfirmed(tenant, provider, row.id, reason, Date.now())) throw new Error('This checkout changed before it could be reconciled.')
    return { released: row.id, tenant, provider }
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(recoverBilling(process.argv.slice(2)))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
