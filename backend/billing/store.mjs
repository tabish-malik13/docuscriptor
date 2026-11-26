import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openBillingStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, provider TEXT NOT NULL, plan TEXT NOT NULL,
      created_at INTEGER NOT NULL, return_url TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('creating','checkout','subscription','closed')),
      checkout_id TEXT, url TEXT, expires_at INTEGER,
      subscription_id TEXT, subscription_plan TEXT, status TEXT, period_end INTEGER,
      UNIQUE (provider, checkout_id), UNIQUE (provider, subscription_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_current_attempt ON attempts(tenant) WHERE phase != 'closed';
    CREATE INDEX IF NOT EXISTS tenant_attempts ON attempts(tenant,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_events (
      provider TEXT NOT NULL, id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (provider,id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS billing_events_received ON billing_events(received_at);
    CREATE TABLE IF NOT EXISTS billing_recoveries (
      attempt_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, provider TEXT NOT NULL,
      resolved_at INTEGER NOT NULL, reason TEXT NOT NULL
    ) STRICT;
  `)
  const current = db.prepare("SELECT * FROM attempts WHERE tenant=? AND phase!='closed'")
  const find = db.prepare('SELECT * FROM attempts WHERE id=?')
  const bound = db.prepare('SELECT * FROM attempts WHERE provider=? AND subscription_id=?')
  const seen = db.prepare('SELECT 1 FROM billing_events WHERE provider=? AND id=?')
  function matchingAttempt(provider, snapshot) {
    const known = bound.get(provider, snapshot.subscriptionId)
    if (known) return known.phase !== 'closed' ? known : null
    if (typeof snapshot.attemptId !== 'string' || typeof snapshot.tenantId !== 'string') return null
    const row = find.get(snapshot.attemptId)
    if (!row || row.phase === 'closed' || row.subscription_id || row.provider !== provider || row.tenant !== snapshot.tenantId) return null
    if (provider === 'razorpay' && row.checkout_id && row.checkout_id !== snapshot.subscriptionId) return null
    // The first grant must match the owner's purchase. Later plan changes follow the bound subscription.
    if (snapshot.status !== 'canceled' && snapshot.plan !== row.plan) return null
    return row
  }
  return {
    close() { db.close() },
    current(tenant) { return current.get(tenant) },
    lastSubscription(tenant) {
      return db.prepare('SELECT * FROM attempts WHERE tenant=? AND subscription_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1').get(tenant)
    },
    start(tenant, provider, plan, returnUrl, now) {
      const id = randomUUID()
      db.prepare("INSERT INTO attempts(id,tenant,provider,plan,created_at,return_url,phase) VALUES(?,?,?,?,?,?,'creating') ON CONFLICT DO NOTHING")
        .run(id, tenant, provider, plan, now, returnUrl)
      return current.get(tenant)
    },
    byId(id) { return find.get(id) },
    bySubscription(provider, id) { return bound.get(provider, id) },
    attach(id, { checkoutId, url, expiresAt }) {
      db.prepare("UPDATE attempts SET phase='checkout',checkout_id=?,url=?,expires_at=? WHERE id=? AND phase='creating'").run(checkoutId, url, expiresAt, id)
    },
    closeCheckout(id) {
      db.prepare("UPDATE attempts SET phase='closed',url=NULL WHERE id=? AND phase IN ('creating','checkout')").run(id)
    },
    releaseUnconfirmed(tenant, provider, attemptId, reason, now) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const { changes } = db.prepare(`UPDATE attempts SET phase='closed' WHERE tenant=? AND provider=? AND id=?
          AND phase='creating' AND checkout_id IS NULL AND subscription_id IS NULL`).run(tenant, provider, attemptId)
        if (changes) db.prepare('INSERT INTO billing_recoveries VALUES(?,?,?,?,?)').run(attemptId, tenant, provider, now, reason)
        db.exec('COMMIT')
        return changes === 1
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    seen(provider, eventId) { return !!seen.get(provider, eventId) },
    sync(provider, snapshot, eventId, now) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const attempt = matchingAttempt(provider, snapshot)
        if (!attempt) {
          db.exec('COMMIT')
          return false
        }
        const recognized = snapshot.plan === 'plus' || snapshot.plan === 'ultimate'
        const status = !recognized && snapshot.status === 'active' ? 'pending' : snapshot.status
        if (provider === 'razorpay' && !attempt.subscription_id && snapshot.checkout && status === 'pending') {
          // A lost creation response can leave a valid, still-payable subscription link.
          const { checkoutId, url, expiresAt } = snapshot.checkout
          if (checkoutId !== snapshot.subscriptionId) throw new Error('The provider returned a different checkout.')
          db.prepare("UPDATE attempts SET phase='checkout',checkout_id=?,url=?,expires_at=? WHERE id=?")
            .run(checkoutId, url, expiresAt, attempt.id)
        } else {
          db.prepare('UPDATE attempts SET phase=?,url=NULL,subscription_id=?,subscription_plan=?,status=?,period_end=? WHERE id=?')
            .run(status === 'canceled' ? 'closed' : 'subscription', snapshot.subscriptionId, recognized ? snapshot.plan : null, status, snapshot.periodEnd ?? null, attempt.id)
        }
        if (eventId) {
          db.prepare('DELETE FROM billing_events WHERE received_at < ?').run(now - 35 * 86_400_000)
          db.prepare('INSERT OR IGNORE INTO billing_events VALUES(?,?,?)').run(provider, eventId, now)
        }
        db.exec('COMMIT')
        return true
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
