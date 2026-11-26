import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const day = 86_400_000
export function openInbox(path) {
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS inbox (
      key TEXT PRIMARY KEY, received INTEGER NOT NULL, next INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      event TEXT, stage TEXT NOT NULL DEFAULT 'pending', result TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inbox_due ON inbox(next) WHERE event IS NOT NULL;
  `)
  const finish = db.prepare("UPDATE inbox SET stage=?, event=NULL, result=NULL WHERE key=?")
  return {
    close: () => db.close(),
    enqueue(events, now) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM inbox WHERE received < ? AND event IS NULL').run(now - 8 * day)
        const insert = db.prepare('INSERT OR IGNORE INTO inbox(key,received,next,event) VALUES(?,?,?,?)')
        const exists = db.prepare('SELECT 1 FROM inbox WHERE key=?')
        let available = 500 - db.prepare('SELECT count(*) AS n FROM inbox WHERE event IS NOT NULL').get().n
        let acceptedAll = true
        for (const event of events) {
          // Keep legacy keys stable across upgrades. Each managed callback has its own delivery namespace.
          const namespace = event.connectionId ? event.connectionId + ':' : ''
          const key = createHash('sha256').update(namespace + event.phoneNumberId + ':' + event.id).digest('hex')
          if (available === 0) {
            if (exists.get(key)) continue
            acceptedAll = false
            break
          }
          available -= Number(insert.run(key, now, now, JSON.stringify(event)).changes)
        }
        db.exec('COMMIT')
        // Keep admitted work on overflow. Meta retries the batch and the unique key skips its accepted prefix.
        return acceptedAll
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    next(now) {
      const row = db.prepare('SELECT * FROM inbox WHERE event IS NOT NULL AND next <= ? ORDER BY next, rowid LIMIT 1').get(now)
      if (!row) return null
      return { ...row, event: JSON.parse(row.event), result: JSON.parse(row.result) }
    },
    stage(key, stage, result = null) {
      db.prepare('UPDATE inbox SET stage=?, result=? WHERE key=?').run(stage, JSON.stringify(result), key)
    },
    defer(key, time) {
      db.prepare('UPDATE inbox SET attempts=attempts+1, next=? WHERE key=?').run(time, key)
    },
    finish(key, state) { finish.run(state, key) },
  }
}
