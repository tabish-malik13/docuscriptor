import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { maxOutputBytes } from '../shared/document-http.mjs'
import { createBatchStore, migrateBatchStore } from './batch-store.mjs'

export function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message })
}

export const defaultWorkspaceLimits = Object.freeze({ storageBytes: 256 * 1024 * 1024, savedTemplates: 100, retainedJobs: 1000 })

export function createStore(path, { quotaBytes, limitsForTenant = () => defaultWorkspaceLimits } = {}) {
  if (path !== ':memory:') {
    path = resolve(path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  if (db.prepare('PRAGMA user_version').get().user_version > 7) {
    db.close()
    throw new Error('This database was created by a newer DocuScripter version.')
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
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
  if (version < 3) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE api_clients (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        scopes TEXT NOT NULL, secret_hash BLOB, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
        rotated_at TEXT, rotated_by TEXT, revoked_at TEXT, revoked_by TEXT,
        CHECK ((revoked_at IS NULL AND secret_hash IS NOT NULL) OR (revoked_at IS NOT NULL AND secret_hash IS NULL))
      ) STRICT;
      CREATE INDEX api_clients_tenant ON api_clients(tenant_id, created_at DESC, id DESC);
      CREATE TABLE api_access_tokens (
        token_hash BLOB PRIMARY KEY, client_id TEXT NOT NULL REFERENCES api_clients(id),
        scopes TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX api_access_tokens_expiry ON api_access_tokens(expires_at);
      CREATE INDEX api_access_tokens_client ON api_access_tokens(client_id);
      CREATE TABLE api_client_audit (
        id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES api_clients(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('client.created','client.rotated','client.revoked')),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX api_client_audit_tenant ON api_client_audit(tenant_id, created_at DESC, id DESC);
      PRAGMA user_version = 3;
      COMMIT;
    `)
  }
  if (version < 4) migrateBatchStore(db)
  if (version < 5) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
      ALTER TABLE templates ADD COLUMN updated TEXT;
      ALTER TABLE templates ADD COLUMN updated_by TEXT;
      CREATE TABLE template_versions (
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1), created TEXT NOT NULL, created_by TEXT NOT NULL,
        fields TEXT NOT NULL, file BLOB NOT NULL,
        PRIMARY KEY(template_id, version)
      ) STRICT;
      ALTER TABLE batches ADD COLUMN saved_template_version INTEGER CHECK(saved_template_version >= 1);
      UPDATE batches SET saved_template_version=1 WHERE saved_template_id IS NOT NULL;
      PRAGMA user_version=5;
      COMMIT;
    `)
  }
  if (version < 6) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS signed_out_sessions (digest BLOB PRIMARY KEY) STRICT, WITHOUT ROWID;
    PRAGMA user_version=6;
    COMMIT;`)
  // Names were immutable before v7, so each historical version has its template's current name.
  if (version < 7) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE template_versions ADD COLUMN name TEXT NOT NULL DEFAULT '';
    UPDATE template_versions SET name=(SELECT name FROM templates WHERE id=template_versions.template_id);
    PRAGMA user_version=7;
    COMMIT;`)
  const endedSession = db.prepare('SELECT 1 FROM signed_out_sessions WHERE digest=?')
  const endSession = db.prepare('INSERT OR IGNORE INTO signed_out_sessions(digest) VALUES(?)')
  // The finish trigger also fails any interrupted batch row and clears its pending data.
  db.prepare("UPDATE jobs SET status='failed', error='Processing was interrupted. Submit the document again.' WHERE status='processing'").run()
  const jobColumns = 'id, owner AS createdBy, name, kind, source, created AS "when", status, error'
  const templateColumns = 'id,name,fields,created,owner AS createdBy,version'
  const templateRecord = row => ({ ...row, fields: JSON.parse(row.fields), saved: true })
  const clientColumns = `id, name, scopes, created_at AS createdAt, created_by AS createdBy,
    rotated_at AS rotatedAt, rotated_by AS rotatedBy, revoked_at AS revokedAt, revoked_by AS revokedBy`
  const clientRecord = (row) => ({ ...row, scopes: JSON.parse(row.scopes) })
  const selectClient = (tenantId, id) => clientRecord(db.prepare(
    `SELECT ${clientColumns} FROM api_clients WHERE tenant_id=? AND id=?`,
  ).get(tenantId, id))
  const addClientEvent = db.prepare('INSERT INTO api_client_audit(tenant_id,client_id,actor_id,action,created_at) VALUES(?,?,?,?,?)')
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = work(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const usageQuery = db.prepare(`SELECT
    COALESCE((SELECT SUM(CASE WHEN status='processing' THEN $reservation ELSE length(artifact) END) FROM jobs WHERE tenant_id=$tenant),0)
    + COALESCE((SELECT SUM(length(file)) FROM templates WHERE tenant_id=$tenant),0)
    + COALESCE((SELECT SUM(length(v.file)) FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE t.tenant_id=$tenant),0)
    + COALESCE((SELECT SUM(r.input_size) FROM batches b JOIN batch_rows r ON r.batch_id=b.id WHERE b.tenant_id=$tenant),0) AS storageBytes,
    (SELECT COUNT(*) FROM templates WHERE tenant_id=$tenant) AS savedTemplates,
    (SELECT COUNT(*) FROM jobs WHERE tenant_id=$tenant) AS retainedJobs`)
  function billingUsage(tenantId) {
    return usageQuery.get({ tenant: tenantId, reservation: maxOutputBytes })
  }
  function checkQuota(tenantId, extra, newRecord) {
    const usage = billingUsage(tenantId)
    const limits = limitsForTenant(tenantId)
    if (newRecord === 'retainedJobs' && usage.retainedJobs >= limits.retainedJobs) {
      throw problem(409, 'Tenant job history limit reached. Delete old jobs before continuing.')
    }
    if (newRecord === 'savedTemplates' && usage.savedTemplates >= limits.savedTemplates) {
      throw problem(409, 'Tenant template limit reached. Delete an old template before uploading another.')
    }
    if (usage.storageBytes + extra > (quotaBytes ?? limits.storageBytes)) {
      throw problem(409, 'Tenant storage limit reached. Delete saved documents, templates or pending batches to free space.')
    }
  }
  // The caller holds the transaction so batch admission and job reservation commit together.
  function reserveJob(tenantId, { name, kind, source, createdBy }) {
    checkQuota(tenantId, maxOutputBytes, 'retainedJobs')
    const id = randomUUID()
    db.prepare("INSERT INTO jobs(id,owner,tenant_id,name,kind,source,created,status) VALUES(?,?,?,?,?,?,?,'processing')")
      .run(id, createdBy, tenantId, name, kind, source, new Date().toISOString())
    return id
  }
  const { cleanExpired, ...batchStore } = createBatchStore(db, { transaction, checkQuota, reserveJob, problem })
  const cleanup = setInterval(() => {
    try { cleanExpired() } catch (error) { process.emitWarning('Batch retention cleanup failed: ' + error.code) }
  }, 60_000)
  cleanup.unref()
  return {
    ...batchStore,
    billingUsage,
    sessionEnded: digest => !!endedSession.get(digest),
    endSession: digest => endSession.run(digest),
    close() { clearInterval(cleanup); db.close() },
    createClient(tenantId, slug, name, scopes, secretHash, subject) {
      return transaction(() => {
        if (db.prepare('SELECT count(*) AS count FROM api_clients WHERE tenant_id=? AND revoked_at IS NULL').get(tenantId).count >= 100) {
          throw problem(409, 'The workspace has reached its limit of 100 active API clients.')
        }
        const id = randomUUID()
        const created = new Date().toISOString()
        db.prepare('INSERT INTO api_clients(id,tenant_id,slug,name,scopes,secret_hash,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, tenantId, slug, name, JSON.stringify(scopes), secretHash, created, subject)
        addClientEvent.run(tenantId, id, subject, 'client.created', created)
        return selectClient(tenantId, id)
      })
    },
    listClients(tenantId, offset, limit = 50) {
      return db.prepare(`SELECT ${clientColumns} FROM api_clients WHERE tenant_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(tenantId, limit, offset).map(clientRecord)
    },
    activeClients(tenantId) {
      return db.prepare('SELECT id,name,scopes FROM api_clients WHERE tenant_id=? AND revoked_at IS NULL ORDER BY name,id')
        .all(tenantId).map(clientRecord)
    },
    clientAudit(tenantId) {
      return db.prepare(`SELECT 'client:' || id AS id, client_id AS target_id, actor_id, action, created_at
        FROM api_client_audit WHERE tenant_id=? ORDER BY created_at DESC, api_client_audit.id DESC LIMIT 50`)
        .all(tenantId).map((row) => ({ ...row, details: {} }))
    },
    rotateClient(tenantId, id, subject, secretHash) {
      return transaction(() => {
        const rotated = new Date().toISOString()
        const changed = db.prepare('UPDATE api_clients SET secret_hash=?,rotated_at=?,rotated_by=? WHERE tenant_id=? AND id=? AND revoked_at IS NULL')
          .run(secretHash, rotated, subject, tenantId, id).changes
        if (!changed) throw problem(404, 'Active API client not found.')
        db.prepare('DELETE FROM api_access_tokens WHERE client_id=?').run(id)
        addClientEvent.run(tenantId, id, subject, 'client.rotated', rotated)
        return selectClient(tenantId, id)
      })
    },
    revokeClient(tenantId, id, subject) {
      return transaction(() => {
        const revoked = new Date().toISOString()
        const changed = db.prepare('UPDATE api_clients SET secret_hash=NULL,revoked_at=?,revoked_by=? WHERE tenant_id=? AND id=? AND revoked_at IS NULL')
          .run(revoked, subject, tenantId, id).changes
        if (!changed) throw problem(404, 'Active API client not found.')
        db.prepare('DELETE FROM api_access_tokens WHERE client_id=?').run(id)
        addClientEvent.run(tenantId, id, subject, 'client.revoked', revoked)
      })
    },
    clientCredential(id) {
      const row = db.prepare('SELECT id,tenant_id AS tenantId,slug,secret_hash AS secretHash,scopes FROM api_clients WHERE id=? AND revoked_at IS NULL').get(id)
      return row && clientRecord(row)
    },
    issueClientToken(id, secretHash, tokenHash, scopes, expiresAt) {
      return transaction(() => {
        db.prepare('DELETE FROM api_access_tokens WHERE expires_at<=?').run(Date.now())
        const active = db.prepare('SELECT count(*) AS count, min(expires_at) AS firstExpiry FROM api_access_tokens WHERE client_id=?').get(id)
        if (active.count >= 256) {
          return { retryAfter: Math.max(1, Math.ceil((active.firstExpiry - Date.now()) / 1000)) }
        }
        const created = db.prepare(`INSERT INTO api_access_tokens(token_hash,client_id,scopes,expires_at)
          SELECT ?,id,?,? FROM api_clients WHERE id=? AND secret_hash=? AND revoked_at IS NULL`)
          .run(tokenHash, JSON.stringify(scopes), expiresAt, id, secretHash).changes
        return { created: created === 1 }
      })
    },
    resolveClientToken(tokenHash) {
      const row = db.prepare(`SELECT c.id,c.tenant_id AS tenantId,c.slug,t.scopes
        FROM api_access_tokens t JOIN api_clients c ON c.id=t.client_id
        WHERE t.token_hash=? AND t.expires_at>? AND c.revoked_at IS NULL`).get(tokenHash, Date.now())
      return row && clientRecord(row)
    },
    listJobs(tenantId, offset = 0, limit = 50) {
      return db.prepare(`SELECT ${jobColumns} FROM jobs WHERE tenant_id=? ORDER BY created DESC, id DESC LIMIT ? OFFSET ?`).all(tenantId, limit, offset)
    },
    job(tenantId, id) { return db.prepare(`SELECT ${jobColumns} FROM jobs WHERE tenant_id=? AND id=?`).get(tenantId, id) },
    artifact(tenantId, id) { return db.prepare("SELECT name, kind, owner AS createdBy, artifact FROM jobs WHERE tenant_id=? AND id=? AND status='ready'").get(tenantId, id) },
    beginJob(tenantId, details) { return transaction(() => reserveJob(tenantId, details)) },
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
    listTemplates(tenantId, creator = null) {
      return db.prepare(`SELECT ${templateColumns} FROM templates
        WHERE tenant_id=$tenantId AND ($creator IS NULL OR owner=$creator) ORDER BY created DESC, id DESC`)
        .all({ tenantId, creator })
        .map(templateRecord)
    },
    templateInfo(tenantId, id) {
      const row = db.prepare(`SELECT ${templateColumns} FROM templates WHERE tenant_id=? AND id=?`).get(tenantId, id)
      return row && templateRecord(row)
    },
    template(tenantId, id, creator = null, version = null) {
      const latest = db.prepare(`SELECT id,name,fields,file,owner AS createdBy,version FROM templates
        WHERE tenant_id=$tenantId AND id=$id AND ($creator IS NULL OR owner=$creator) AND ($version IS NULL OR version=$version)`)
        .get({ tenantId, id, creator, version })
      if (latest || version === null) return latest
      return db.prepare(`SELECT t.id,v.name,v.fields,v.file,t.owner AS createdBy,v.version
        FROM templates t JOIN template_versions v ON v.template_id=t.id
        WHERE t.tenant_id=$tenantId AND t.id=$id AND ($creator IS NULL OR t.owner=$creator) AND v.version=$version`)
        .get({ tenantId, id, creator, version })
    },
    templateVersions(tenantId, id) {
      return db.prepare(`SELECT version, name, COALESCE(updated,created) AS created, COALESCE(updated_by,owner) AS createdBy
        FROM templates WHERE tenant_id=$tenantId AND id=$id
        UNION ALL SELECT v.version,v.name,v.created,v.created_by FROM template_versions v JOIN templates t ON t.id=v.template_id
        WHERE t.tenant_id=$tenantId AND t.id=$id ORDER BY version DESC`).all({ tenantId, id })
    },
    saveTemplate(tenantId, name, fields, bytes, createdBy) {
      return transaction(() => {
        checkQuota(tenantId, bytes.length, 'savedTemplates')
        const id = randomUUID()
        db.prepare('INSERT INTO templates(id,owner,tenant_id,name,fields,file,created) VALUES(?,?,?,?,?,?,?)')
          .run(id, createdBy, tenantId, name, JSON.stringify(fields), bytes, new Date().toISOString())
        return { id, name, fields, version: 1, saved: true }
      })
    },
    reviseTemplate(tenantId, id, baseVersion, fields, bytes, subject, name) {
      if ((fields == null) !== (bytes == null)) throw new TypeError('Supply template fields and DOCX bytes together.')
      return transaction(() => {
        const head = db.prepare('SELECT name,version,fields,length(file) AS size FROM templates WHERE tenant_id=? AND id=?').get(tenantId, id)
        if (!head) throw problem(404, 'Template not found.')
        if (head.version !== baseVersion) throw problem(409, 'This template has a newer version. Reopen it before saving another version.')
        const nextName = name ?? head.name
        const nextFields = fields ?? JSON.parse(head.fields)
        if (bytes == null && nextName === head.name) return { id, name: nextName, fields: nextFields, version: baseVersion, saved: true }
        checkQuota(tenantId, bytes?.length ?? head.size)
        db.prepare(`INSERT INTO template_versions(template_id,version,created,created_by,name,fields,file)
          SELECT id,version,COALESCE(updated,created),COALESCE(updated_by,owner),name,fields,file FROM templates WHERE tenant_id=? AND id=?`)
          .run(tenantId, id)
        const version = baseVersion + 1
        db.prepare('UPDATE templates SET version=?,name=?,fields=?,file=COALESCE(?,file),updated=?,updated_by=? WHERE tenant_id=? AND id=?')
          .run(version, nextName, JSON.stringify(nextFields), bytes ?? null, new Date().toISOString(), subject, tenantId, id)
        return { id, name: nextName, fields: nextFields, version, saved: true }
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
          + COALESCE((SELECT SUM(length(file)) FROM templates WHERE tenant_id IS NULL AND owner=?),0)
          + COALESCE((SELECT SUM(length(v.file)) FROM template_versions v JOIN templates t ON t.id=v.template_id
            WHERE t.tenant_id IS NULL AND t.owner=?),0) AS used`).get(subject,subject,subject)
        checkQuota(tenantId, used)
        const limits = limitsForTenant(tenantId)
        for (const [table, max] of [['jobs',limits.retainedJobs],['templates',limits.savedTemplates]]) {
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
