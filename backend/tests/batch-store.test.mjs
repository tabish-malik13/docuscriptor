import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maxOutputBytes } from '../shared/document-http.mjs'
import { createStore } from '../gateway/store.mjs'

function input(count = 2) {
  return {
    templateId: 'letter', templateName: 'Business letter', format: 'DOCX',
    rows: Array.from({ length: count }, (_, i) => ({ name: 'letter-' + (i + 1) + '.docx', values: { name: 'private-row-' + i } })),
  }
}

async function temporaryPath(t) {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-batch-storage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'workspace.sqlite')
}

test('creator owns the batch, each row claims one job, and a deleted artifact remains detectable', (t) => {
  const store = createStore(':memory:')
  t.after(() => store.close())
  const tenant = randomUUID(), subject = randomUUID()
  const batch = store.createBatch(tenant, subject, input())
  assert.equal(batch.pending, 2)
  assert.deepEqual(batch.rows.map(row => row.index), [1, 2])
  assert.ok(!JSON.stringify(batch).includes('private-row'))
  for (const [workspace, actor] of [[randomUUID(), subject], [tenant, randomUUID()]]) {
    assert.equal(store.batch(workspace, actor, batch.id), undefined)
    assert.deepEqual(store.listBatches(workspace, actor), [])
    assert.throws(() => store.claimBatchRow(workspace, actor, batch.id), { statusCode: 404 })
    assert.equal(store.deleteBatch(workspace, actor, batch.id), false)
  }
  const row = store.claimBatchRow(tenant, subject, batch.id)
  assert.equal(row.index, 1)
  assert.equal(row.values.name, 'private-row-0')
  assert.equal(store.job(tenant, row.jobId).createdBy, subject)
  assert.throws(() => store.claimBatchRow(tenant, subject, batch.id), { statusCode: 409 })
  assert.throws(() => store.deleteBatch(tenant, subject, batch.id), { statusCode: 409 })
  store.completeJob(randomUUID(), row.jobId, Buffer.from('PK'))
  assert.equal(store.batch(tenant, subject, batch.id).processing, 1)
  store.completeJob(tenant, row.jobId, Buffer.from('PK'))
  const second = store.claimBatchRow(tenant, subject, batch.id)
  store.failJob(tenant, second.jobId, 'Failed to render.')
  assert.equal(store.claimBatchRow(tenant, subject, batch.id), null)
  assert.deepEqual(store.batch(tenant, subject, batch.id).rows.map(row => [row.status, row.available, row.size]),
    [['ready', true, 2], ['failed', false, 0]])
  store.deleteJob(tenant, row.jobId)
  const missing = store.batch(tenant, subject, batch.id).rows[0]
  assert.equal(missing.jobId, row.jobId)
  assert.equal(missing.available, false)
  assert.equal(store.deleteBatch(tenant, subject, batch.id), true)
  assert.equal(store.job(tenant, second.jobId).status, 'failed')
})

test('pending UTF-8 bytes count against quota and a failed job reservation leaves the row pending', (t) => {
  const tenant = randomUUID(), subject = randomUUID(), batchInput = input(1)
  batchInput.rows[0].values.name = '漢字'
  const bytes = Buffer.byteLength(JSON.stringify(batchInput.rows[0].values))
  const store = createStore(':memory:', { quotaBytes: maxOutputBytes + bytes - 1 })
  t.after(() => store.close())
  const run = store.createBatch(tenant, subject, batchInput)
  assert.throws(() => store.claimBatchRow(tenant, subject, run.id), { statusCode: 409 })
  assert.deepEqual(store.listJobs(tenant), [])
  assert.equal(store.batch(tenant, subject, run.id).pending, 1)
  store.deleteBatch(tenant, subject, run.id)
  assert.ok(store.beginJob(tenant, { name: 'released.docx', kind: 'DOCX', source: 'file.docx', createdBy: subject }))
})

test('idempotency compares ordered rows, tolerates value key order, and has tenant and creator scope', (t) => {
  const store = createStore(':memory:')
  t.after(() => store.close())
  const tenant = randomUUID(), subject = randomUUID()
  const payload = { ...input(), idempotencyKey: randomUUID() }
  payload.rows[0].values = { foo: '1', bar: '2' }
  const original = store.createBatch(tenant, subject, payload)
  payload.rows[0].values = { bar: '2', foo: '1' }
  assert.equal(store.batchByKey(tenant, subject, payload).id, original.id)
  assert.equal(store.createBatch(tenant, subject, payload).id, original.id)
  payload.rows.reverse()
  assert.throws(() => store.batchByKey(tenant, subject, payload), { statusCode: 409 })
  assert.throws(() => store.createBatch(tenant, subject, payload), { statusCode: 409 })
  assert.notEqual(store.createBatch(randomUUID(), subject, payload).id, original.id)
  assert.notEqual(store.createBatch(tenant, randomUUID(), payload).id, original.id)
})

test('row input is cleared at completion or interruption, and pending rows can resume after restart', async (t) => {
  const path = await temporaryPath(t), tenant = randomUUID(), subject = randomUUID()
  let store = createStore(path)
  t.after(() => store.close())
  const run = store.createBatch(tenant, subject, input(3))
  const first = store.claimBatchRow(tenant, subject, run.id)
  store.completeJob(tenant, first.jobId, Buffer.from('PK'))
  const second = store.claimBatchRow(tenant, subject, run.id)
  store.close()
  store = createStore(path)
  const after = store.batch(tenant, subject, run.id)
  assert.deepEqual(after.rows.map(row => row.status), ['ready', 'failed', 'pending'])
  assert.match(after.rows[1].error, /interrupted/i)
  assert.equal(store.job(tenant, second.jobId).status, 'failed')
  const db = new DatabaseSync(path)
  try {
    assert.deepEqual(db.prepare('SELECT input FROM batch_rows ORDER BY position').all().map(row => row.input),
      [null, null, JSON.stringify({ name: 'private-row-2' })])
  } finally { db.close() }
  const third = store.claimBatchRow(tenant, subject, run.id)
  assert.equal(third.index, 3)
  assert.equal(store.listJobs(tenant).length, 3)
})

test('the retention sweep deletes expired rosters and preserves independent document history', async (t) => {
  const path = await temporaryPath(t), tenant = randomUUID(), subject = randomUUID()
  let store = createStore(path)
  t.after(() => store.close())
  const run = store.createBatch(tenant, subject, input())
  const first = store.claimBatchRow(tenant, subject, run.id)
  store.completeJob(tenant, first.jobId, Buffer.from('PK'))
  store.close()
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE batches SET created=? WHERE id=?').run(new Date(0).toISOString(), run.id) } finally { db.close() }
  store = createStore(path)
  assert.deepEqual(store.listBatches(tenant, subject), [])
  assert.deepEqual(Buffer.from(store.artifact(tenant, first.jobId).artifact), Buffer.from('PK'))
  const reopened = new DatabaseSync(path)
  try { assert.equal(reopened.prepare('SELECT count(*) AS n FROM batch_rows').get().n, 0) } finally { reopened.close() }
})

test('an existing version 3 workspace upgrades with its jobs and client grants intact', async (t) => {
  const path = await temporaryPath(t), tenant = randomUUID(), subject = randomUUID()
  let store = createStore(path)
  const jobId = store.beginJob(tenant, { name: 'prior.docx', kind: 'DOCX', source: 'letter', createdBy: subject })
  store.completeJob(tenant, jobId, Buffer.from('PK'))
  const client = store.createClient(tenant, 'workspace', 'Existing client', ['documents:generate'], Buffer.alloc(32), subject)
  store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec(`DROP TABLE template_versions;
      ALTER TABLE templates DROP COLUMN updated_by;
      ALTER TABLE templates DROP COLUMN updated;
      ALTER TABLE templates DROP COLUMN version;
      DROP TRIGGER batch_finish_row; DROP TABLE batch_rows; DROP TABLE batches; PRAGMA user_version=3;`)
  } finally { db.close() }
  store = createStore(path)
  t.after(() => store.close())
  assert.equal(store.job(tenant, jobId).status, 'ready')
  assert.deepEqual(store.clientCredential(client.id).scopes, ['documents:generate'])
  assert.deepEqual(store.listBatches(tenant, subject), [])
  assert.equal(store.createBatch(tenant, subject, input(1)).total, 1)
})

test('if a batch row cannot finalize, its job also stays processing until completion succeeds', async (t) => {
  const path = await temporaryPath(t), tenant = randomUUID(), subject = randomUUID()
  const store = createStore(path)
  t.after(() => store.close())
  const run = store.createBatch(tenant, subject, input(1))
  const row = store.claimBatchRow(tenant, subject, run.id)
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER test_write_failure BEFORE UPDATE OF status ON batch_rows BEGIN SELECT RAISE(ABORT,'write failure'); END;")
    assert.throws(() => store.completeJob(tenant, row.jobId, Buffer.from('PK')), /write failure/)
    assert.throws(() => store.failJob(tenant, row.jobId, 'Failed'), /write failure/)
    assert.equal(store.job(tenant, row.jobId).status, 'processing')
    assert.equal(store.batch(tenant, subject, run.id).processing, 1)
    db.exec('DROP TRIGGER test_write_failure')
  } finally { db.close() }
  store.completeJob(tenant, row.jobId, Buffer.from('PK'))
  assert.equal(store.batch(tenant, subject, run.id).ready, 1)
})
