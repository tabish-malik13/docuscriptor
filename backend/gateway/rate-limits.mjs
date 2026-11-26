import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { isIP } from 'node:net'
import { DatabaseSync } from 'node:sqlite'

const minute = 60_000
const policies = {
  ip: ['RATE_LIMIT_IP_PER_MINUTE', 120],
  token: ['RATE_LIMIT_TOKEN_PER_MINUTE', 20],
  webhook: ['RATE_LIMIT_WEBHOOK_PER_MINUTE', 120],
  subject: ['RATE_LIMIT_SUBJECT_PER_MINUTE', 120],
  tenant: ['RATE_LIMIT_TENANT_PER_MINUTE', 600],
  write: ['RATE_LIMIT_WRITE_PER_MINUTE', 20],
  tenantWrite: ['RATE_LIMIT_TENANT_WRITE_PER_MINUTE', 60],
}

export function rateLimitOptions(env = process.env) {
  return Object.fromEntries(Object.entries(policies).map(([policy, [name, fallback]]) => {
    const value = env[name] ?? String(fallback)
    if (!/^[1-9]\d{0,6}$/.test(value)) throw new Error(name + ' must be a positive integer of at most seven digits.')
    return [policy, Number(value)]
  }))
}

export function rateLimitTrustedProxies(env = process.env) {
  if (!env.RATE_LIMIT_TRUSTED_PROXIES?.trim()) return false
  const addresses = env.RATE_LIMIT_TRUSTED_PROXIES.split(',').map((entry) => entry.trim())
  for (const address of addresses) {
    const [ip, prefix, extra] = address.split('/')
    const version = isIP(ip)
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^[1-9]\d{0,2}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('RATE_LIMIT_TRUSTED_PROXIES requires a comma-separated list of proxy IPs or CIDRs with nonzero prefix lengths.')
    }
  }
  return addresses
}

function sourceNetwork(request) {
  const ip = isIP(request.ip) ? request.ip : request.raw.socket.remoteAddress || 'unknown'
  if (isIP(ip) !== 6) return ip
  // Canonicalize mapped IPv4 and group IPv6 privacy addresses on one /64.
  const address = new URL('http://[' + ip.split('%')[0] + ']').hostname.slice(1, -1)
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address)
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16)
    return [high >> 8, high & 255, low >> 8, low & 255].join('.')
  }
  const [left, right] = address.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const words = [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
  return words.slice(0, 4).join(':') + '::/64'
}

function bucket(limit, ...parts) {
  return { limit, key: createHash('sha256').update(JSON.stringify(parts)).digest() }
}

function createCounters(path) {
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  // The limiter has its own DB. Bound growth from many distinct public source IPs.
  db.exec(`
    PRAGMA busy_timeout = 100;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA max_page_count = 8192;
    CREATE TABLE IF NOT EXISTS buckets (
      key BLOB PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS buckets_expiry ON buckets(expires);
  `)
  const purge = db.prepare('DELETE FROM buckets WHERE expires <= ?')
  const read = db.prepare('SELECT hits, expires FROM buckets WHERE key = ?')
  const update = db.prepare(`INSERT INTO buckets (key, hits, expires) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET hits = excluded.hits, expires = excluded.expires`)
  let nextPurge = 0
  return {
    close() { db.close() },
    consume(budgets, now) {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (now >= nextPurge) purge.run(now)
        const updates = []
        let retry = 0
        for (const { key, limit } of budgets) {
          const current = read.get(key)
          const active = current && current.expires > now
          const hits = active ? current.hits : 0
          const expires = active ? current.expires : now + minute
          if (hits >= limit) retry = Math.max(retry, Math.ceil((expires - now) / 1000))
          updates.push([key, hits + 1, expires])
        }
        // A throttled actor cannot consume another actor's shared tenant budget.
        if (!retry) for (const args of updates) update.run(...args)
        db.exec('COMMIT')
        if (now >= nextPurge) nextPurge = now + minute
        return retry
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

export function registerGatewayRateLimits(app, { storePath, options = {}, now = Date.now, workspaceLimits = true }) {
  const limits = { ...rateLimitOptions(), ...options }
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(policies, key) || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid rate limit: ' + key)
  }
  const counters = createCounters(storePath === ':memory:' ? storePath : storePath + '.limits.sqlite')
  app.addHook('onClose', async () => counters.close())
  function enforce(request, reply, budgets) {
    let retry
    try {
      retry = counters.consume(budgets, now())
    } catch (error) {
      request.log.error({ code: error.code }, 'Rate limit database unavailable')
      return reply.code(503).header('Retry-After', '1').send({ message: 'Request limits are temporarily unavailable.' })
    }
    if (retry) return reply.code(429).header('Retry-After', String(retry)).send({ message: 'Too many requests. Try again shortly.' })
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/api/health' && ['GET','HEAD'].includes(request.method)) return
    const rateClass = request.routeOptions.config?.rateClass
    const category = rateClass === 'token' || rateClass === 'webhook' ? rateClass : 'ip'
    return enforce(request, reply, [bucket(limits[category], category, sourceNetwork(request))])
  })
  app.addHook('preParsing', async (request, reply, payload) => {
    const actor = request.subject
    const tenant = request.tenantId
    const write = request.routeOptions.config?.rateClass !== 'preview' && !['GET','HEAD','OPTIONS'].includes(request.method)
    const budgets = []
    if (workspaceLimits && actor) {
      budgets.push(bucket(limits.subject, 'subject', tenant, actor))
      if (write) budgets.push(bucket(limits.write, 'write', tenant, actor))
    }
    if (workspaceLimits && tenant && actor) {
      budgets.push(bucket(limits.tenant, 'tenant', tenant))
      if (write) budgets.push(bucket(limits.tenantWrite, 'tenantWrite', tenant))
    }
    const routeLimit = request.routeOptions.config?.rateLimit?.max
    if (Number.isInteger(routeLimit)) budgets.push(bucket(routeLimit, 'route', request.method,
      request.routeOptions.url, tenant, actor || sourceNetwork(request)))
    if (budgets.length) {
      const blocked = enforce(request, reply, budgets)
      if (blocked) return blocked
    }
    return payload
  })
}
