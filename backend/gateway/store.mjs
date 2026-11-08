import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { maxOutputBytes } from '../shared/document-http.mjs'

export function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message })
}

export function createStore(path, { quotaBytes = 256 * 1024 * 1024 } = {}) {
  if (path !== ':memory:') {
    path = resolve(path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  if (db.prepare('PRAGMA user_version').get().user_version > 2) {
    db.close()
    throw new Error('This database was created by a newer DocuScripter version.')
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('DOCX','PDF')), source TEXT NOT NULL,
      created TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
      error TEXT, artifact BLOB
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created DESC, id DESC);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      created TEXT NOT NULL, fields TEXT NOT NULL, file BLOB NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS templates_owner ON templates(owner, created DESC);

  `)
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version < 2) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE jobs ADD COLUMN tenant_id TEXT;
      ALTER TABLE templates ADD COLUMN tenant_id TEXT;
      CREATE INDEX jobs_tenant ON jobs(tenant_id, created DESC, id DESC);
      CREATE INDEX templates_tenant ON templates(tenant_id, created DESC, id DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }
  // This store supports one gateway process. A stopped synchronous job cannot resume.
  db.prepare("UPDATE jobs SET status='failed', error='Processing was interrupted. Submit the document again.' WHERE status='processing'").run()
  const jobColumns = 'id, owner AS createdBy, name, kind, source, created AS "when", status, error'
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function checkQuota(tenantId, extra) {
    const { used } = db.prepare(`SELECT
      COALESCE((SELECT SUM(CASE WHEN status='processing' THEN ? ELSE length(artifact) END) FROM jobs WHERE tenant_id=?),0)
      + COALESCE((SELECT SUM(length(file)) FROM templates WHERE tenant_id=?),0) AS used`).get(maxOutputBytes, tenantId, tenantId)
    if (used + extra > quotaBytes) throw problem(409, 'Tenant storage limit reached. Delete saved documents or templates to free space.')
  }
  return {
    close: () => db.close(),
    listJobs(tenantId, offset = 0) {
      return db.prepare(`SELECT ${jobColumns} FROM jobs WHERE tenant_id=? ORDER BY created DESC, id DESC LIMIT 50 OFFSET ?`).all(tenantId, offset)
    },
    job(tenantId, id) { return db.prepare(`SELECT ${jobColumns} FROM jobs WHERE tenant_id=? AND id=?`).get(tenantId, id) },
    artifact(tenantId, id) { return db.prepare("SELECT name, kind, artifact FROM jobs WHERE tenant_id=? AND id=? AND status='ready'").get(tenantId, id) },
    beginJob(tenantId, { name, kind, source, createdBy }) {
      return transaction(() => {
        if (db.prepare('SELECT count(*) AS count FROM jobs WHERE tenant_id=?').get(tenantId).count >= 1000) {
          throw problem(409, 'Tenant job history limit reached. Delete old jobs before continuing.')
        }
        checkQuota(tenantId, maxOutputBytes)
        const id = randomUUID()
        db.prepare("INSERT INTO jobs(id,owner,tenant_id,name,kind,source,created,status) VALUES(?,?,?,?,?,?,?,'processing')")
          .run(id, createdBy, tenantId, name, kind, source, new Date().toISOString())
        return id
      })
    },
    completeJob(tenantId, id, bytes) {
      if (!bytes.length || bytes.length > maxOutputBytes) throw new Error('Invalid artifact size')
      db.prepare("UPDATE jobs SET status='ready', artifact=? WHERE tenant_id=? AND id=? AND status='processing'").run(bytes, tenantId, id)
    },
    failJob(tenantId, id, message) {
      db.prepare("UPDATE jobs SET status='failed', error=? WHERE tenant_id=? AND id=? AND status='processing'").run(message, tenantId, id)
    },
    deleteJob(tenantId, id) {
      if (db.prepare("SELECT id FROM jobs WHERE tenant_id=? AND id=? AND status='processing'").get(tenantId, id)) {
        throw problem(409, 'Wait for this document to finish processing.')
      }
      return db.prepare('DELETE FROM jobs WHERE tenant_id=? AND id=?').run(tenantId, id).changes > 0
    },
    listTemplates(tenantId) {
      return db.prepare('SELECT id,name,fields,created,owner AS createdBy FROM templates WHERE tenant_id=? ORDER BY created DESC, id DESC').all(tenantId)
        .map((row) => ({ ...row, fields: JSON.parse(row.fields), saved: true }))
    },
    template(tenantId, id) { return db.prepare('SELECT id,name,fields,file,owner AS createdBy FROM templates WHERE tenant_id=? AND id=?').get(tenantId, id) },
    saveTemplate(tenantId, name, fields, bytes, createdBy) {
      return transaction(() => {
        if (db.prepare('SELECT count(*) AS count FROM templates WHERE tenant_id=?').get(tenantId).count >= 100) {
          throw problem(409, 'Tenant template limit reached. Delete an old template before uploading another.')
        }
        checkQuota(tenantId, bytes.length)
        const id = randomUUID()
        db.prepare('INSERT INTO templates(id,owner,tenant_id,name,fields,file,created) VALUES(?,?,?,?,?,?,?)')
          .run(id, createdBy, tenantId, name, JSON.stringify(fields), bytes, new Date().toISOString())
        return { id, name, fields, saved: true }
      })
    },
    deleteTemplate(tenantId, id) { return db.prepare('DELETE FROM templates WHERE tenant_id=? AND id=?').run(tenantId, id).changes > 0 },
    legacySummary(subject) {
      return {
        jobs: db.prepare('SELECT count(*) AS count FROM jobs WHERE tenant_id IS NULL AND owner=?').get(subject).count,
        templates: db.prepare('SELECT count(*) AS count FROM templates WHERE tenant_id IS NULL AND owner=?').get(subject).count,
      }
    },
    importLegacy(tenantId, subject) {
      return transaction(() => {
        const { used } = db.prepare(`SELECT
          COALESCE((SELECT SUM(length(artifact)) FROM jobs WHERE tenant_id IS NULL AND owner=?),0)
          + COALESCE((SELECT SUM(length(file)) FROM templates WHERE tenant_id IS NULL AND owner=?),0) AS used`).get(subject,subject)
        checkQuota(tenantId, used)
        for (const [table, max] of [['jobs',1000],['templates',100]]) {
          const { count } = db.prepare(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=? OR (tenant_id IS NULL AND owner=?)`).get(tenantId,subject)
          if (count > max) throw problem(409, 'Import would exceed a tenant record limit.')
        }
        const jobs = db.prepare('UPDATE jobs SET tenant_id=? WHERE tenant_id IS NULL AND owner=?').run(tenantId,subject).changes
        const templates = db.prepare('UPDATE templates SET tenant_id=? WHERE tenant_id IS NULL AND owner=?').run(tenantId,subject).changes
        return { jobs,templates }
      })
    },
  }
}
