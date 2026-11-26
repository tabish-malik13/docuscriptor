import { createHash, randomUUID } from 'node:crypto'

const retentionDays = 30
function requestHash({ templateId, savedTemplateId, format, rows }) {
  const canonicalRows = rows.map(({ name, values }) =>
    [name, Object.keys(values).sort().map((field) => [field, values[field]])])
  return createHash('sha256').update(JSON.stringify([templateId ?? null, savedTemplateId ?? null, format, canonicalRows])).digest('hex')
}

export function migrateBatchStore(db) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE batches (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner TEXT NOT NULL, created TEXT NOT NULL,
      template_id TEXT, saved_template_id TEXT, template_name TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('DOCX','PDF')),
      request_key TEXT, request_hash TEXT, UNIQUE(tenant_id,owner,request_key),
      CHECK((template_id IS NULL) <> (saved_template_id IS NULL))
    ) STRICT;
    CREATE INDEX batches_owner ON batches(tenant_id, owner, created DESC, id DESC);
    CREATE INDEX batches_created ON batches(created);
    CREATE TABLE batch_rows (
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 100), name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','ready','failed')),
      job_id TEXT UNIQUE, error TEXT, input_size INTEGER NOT NULL, input TEXT,
      PRIMARY KEY(batch_id,position),
      CHECK((status IN ('pending','processing')) = (input IS NOT NULL)),
      CHECK((status = 'pending') = (job_id IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX batch_one_active ON batch_rows(batch_id) WHERE status='processing';
    -- Finishing the artifact and erasing the row values must succeed together, even on recovery.
    CREATE TRIGGER batch_finish_row AFTER UPDATE OF status ON jobs
    WHEN OLD.status='processing' AND NEW.status IN ('ready','failed') BEGIN
      UPDATE batch_rows SET status=NEW.status, error=NEW.error, input=NULL, input_size=0
      WHERE job_id=NEW.id AND status='processing' AND batch_id IN
        (SELECT id FROM batches WHERE tenant_id=NEW.tenant_id AND owner=NEW.owner);
    END;
    PRAGMA user_version = 4;
    COMMIT;
  `)
}

export function createBatchStore(db, { transaction, checkQuota, reserveJob, problem }) {
  const summaries = `SELECT b.id, b.created, b.template_id AS templateId, b.saved_template_id AS savedTemplateId,
    b.saved_template_version AS savedTemplateVersion,b.template_name AS templateName, b.format, count(*) AS total, sum(r.status='pending') AS pending,
    sum(r.status='processing') AS processing, sum(r.status='ready') AS ready, sum(r.status='failed') AS failed
    FROM batches b JOIN batch_rows r ON r.batch_id=b.id WHERE b.tenant_id=? AND b.owner=?`
  const list = db.prepare(summaries + ' GROUP BY b.id ORDER BY b.created DESC, b.id DESC')
  const one = db.prepare(summaries + ' AND b.id=? GROUP BY b.id')
  const rows = db.prepare(`SELECT r.position AS "index", r.name, r.status, r.job_id AS jobId, r.error,
    j.id IS NOT NULL AS available, COALESCE(length(j.artifact),0) AS size
    FROM batches b JOIN batch_rows r ON r.batch_id=b.id LEFT JOIN jobs j ON j.id=r.job_id
    AND j.tenant_id=b.tenant_id AND j.owner=b.owner AND j.status='ready'
    WHERE b.tenant_id=? AND b.owner=? AND b.id=? ORDER BY r.position`)
  const expire = db.prepare(`DELETE FROM batches WHERE created < ? AND NOT EXISTS
    (SELECT 1 FROM batch_rows WHERE batch_id=batches.id AND status='processing')`)
  let nextCleanup = 0
  function cleanExpired() {
    const now = Date.now()
    if (now < nextCleanup) return
    expire.run(new Date(now - retentionDays * 86_400_000).toISOString())
    nextCleanup = now + 60_000
  }
  function batch(tenantId, subject, id) {
    cleanExpired()
    const summary = one.get(tenantId, subject, id)
    if (!summary) return undefined
    return { ...summary, rows: rows.all(tenantId, subject, id).map((item) => ({ ...item, available: Boolean(item.available) })) }
  }
  function previousBatch(tenantId, subject, key, hash) {
    const previous = db.prepare('SELECT id, request_hash FROM batches WHERE tenant_id=? AND owner=? AND request_key=?').get(tenantId, subject, key)
    if (!previous) return undefined
    if (previous.request_hash !== hash) throw problem(409, 'This idempotency key was already used with different batch inputs.')
    return batch(tenantId, subject, previous.id)
  }
  cleanExpired()
  return {
    cleanExpired,
    batch,
    batchByKey(tenantId, subject, payload) {
      cleanExpired()
      if (!payload.idempotencyKey) return undefined
      return previousBatch(tenantId, subject, payload.idempotencyKey.toLowerCase(), requestHash(payload))
    },
    listBatches(tenantId, subject) {
      cleanExpired()
      return list.all(tenantId, subject)
    },
    createBatch(tenantId, subject, { templateId, savedTemplateId, savedTemplateVersion, templateName, format, rows: inputs, idempotencyKey }) {
      cleanExpired()
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw problem(400, 'Choose between 1 and 100 rows per batch.')
      const encoded = inputs.map(({ name, values }) => {
        const input = JSON.stringify(values)
        return { name, input, size: Buffer.byteLength(input) }
      })
      const key = idempotencyKey?.toLowerCase() ?? null
      const hash = key && requestHash({ templateId, savedTemplateId, format, rows: inputs })
      return transaction(() => {
        if (key) {
          const previous = previousBatch(tenantId, subject, key, hash)
          if (previous) return previous
        }
        const { count } = db.prepare('SELECT count(*) AS count FROM batches WHERE tenant_id=?').get(tenantId)
        if (count >= 100) throw problem(409, 'This organization has 100 retained batches. Delete a batch or wait for its 30-day retention period to end.')
        checkQuota(tenantId, encoded.reduce((sum, item) => sum + item.size, 0))
        const id = randomUUID()
        db.prepare(`INSERT INTO batches(id,tenant_id,owner,created,template_id,saved_template_id,saved_template_version,
          template_name,format,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, tenantId, subject, new Date().toISOString(), templateId ?? null, savedTemplateId ?? null,
            savedTemplateVersion ?? null, templateName, format, key, hash)
        const insert = db.prepare("INSERT INTO batch_rows(batch_id,position,name,status,input_size,input) VALUES(?,?,?,'pending',?,?)")
        encoded.forEach((item, i) => insert.run(id, i + 1, item.name, item.size, item.input))
        return batch(tenantId, subject, id)
      })
    },
    claimBatchRow(tenantId, subject, id, expected) {
      cleanExpired()
      return transaction(() => {
        const summary = one.get(tenantId, subject, id)
        if (!summary) throw problem(404, 'Batch not found.')
        // Comparing inside the claim transaction makes retrying a first-file review safe across tabs.
        if (expected) {
          const target = db.prepare('SELECT status FROM batch_rows WHERE batch_id=? AND position=?').get(id, expected)
          if (!target) throw problem(400, 'This batch does not contain the requested row.')
          if (target.status !== 'pending') return null
        }
        if (summary.processing) throw problem(409, 'A row in this batch is already processing.')
        if (!summary.pending) return null
        const row = db.prepare(`SELECT position AS "index", name, input FROM batch_rows
          WHERE batch_id=? AND status='pending' ORDER BY position LIMIT 1`).get(id)
        if (expected && row.index !== expected) throw problem(409, 'Process the earlier pending rows first.')
        const jobId = reserveJob(tenantId, { name: row.name, kind: summary.format, source: summary.templateName, createdBy: subject })
        db.prepare("UPDATE batch_rows SET status='processing', job_id=? WHERE batch_id=? AND position=?").run(jobId, id, row.index)
        return { jobId, index: row.index, name: row.name, values: JSON.parse(row.input) }
      })
    },
    deleteBatch(tenantId, subject, id) {
      return transaction(() => {
        const summary = one.get(tenantId, subject, id)
        if (summary?.processing) throw problem(409, 'Wait for the active batch row to finish.')
        return db.prepare('DELETE FROM batches WHERE tenant_id=? AND owner=? AND id=?').run(tenantId, subject, id).changes > 0
      })
    },
  }
}
