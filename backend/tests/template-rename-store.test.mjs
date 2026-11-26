import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../gateway/store.mjs'

test('v6 history keeps its original names after independent orgs rename and replace templates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'docuscripter-template-names-'))
  const path = join(directory, 'store.sqlite')
  const tenant = randomUUID(), otherTenant = randomUUID(), creator = randomUUID()
  const actor = 'client:' + randomUUID()
  const original = Buffer.from('original'), revision = Buffer.from('revision'), replacement = Buffer.from('replacement')
  let store = createStore(path)
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const id = store.saveTemplate(tenant, 'Agreement', ['original'], original, creator).id
  const otherId = store.saveTemplate(otherTenant, 'Receipt', [], original, creator).id
  store.reviseTemplate(tenant, id, 1, ['second'], revision, actor)
  store.reviseTemplate(otherTenant, otherId, 1, [], revision, actor)
  store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec('ALTER TABLE template_versions DROP COLUMN name; PRAGMA user_version=6;')
  } finally { db.close() }

  store = createStore(path)
  const rename = store.reviseTemplate(tenant, id, 2, null, null, actor, 'Signed agreement')
  assert.deepEqual(rename, { id, name: 'Signed agreement', fields: ['second'], version: 3, saved: true })
  store.reviseTemplate(tenant, id, 3, ['next'], replacement, creator, 'Amendment')
  store.reviseTemplate(otherTenant, otherId, 2, null, null, actor, 'Paid receipt')
  store.close()

  store = createStore(path)
  assert.equal(store.template(otherTenant, otherId, null, 1).name, 'Receipt')
  assert.deepEqual(store.templateVersions(tenant, id).map(v => [v.version, v.name, v.createdBy]), [
    [4, 'Amendment', creator], [3, 'Signed agreement', actor], [2, 'Agreement', actor], [1, 'Agreement', creator],
  ])
  for (const [version, name, field, bytes] of [
    [1, 'Agreement', 'original', original], [2, 'Agreement', 'second', revision],
    [3, 'Signed agreement', 'second', revision], [4, 'Amendment', 'next', replacement],
  ]) {
    const snapshot = store.template(tenant, id, null, version)
    assert.equal(snapshot.name, name)
    assert.deepEqual(JSON.parse(snapshot.fields), [field])
    assert.deepEqual(Buffer.from(snapshot.file), bytes)
  }
  const metadata = store.templateInfo(tenant, id)
  assert.deepEqual(metadata, { id, name: 'Amendment', fields: ['next'], version: 4, saved: true, createdBy: creator, created: metadata.created })
  assert.ok(Date.parse(metadata.created))
  assert.deepEqual(store.listTemplates(tenant), [metadata])
  assert.equal(store.templateInfo(otherTenant, id), undefined)

  const connection = new DatabaseSync(path)
  try {
    connection.exec("CREATE TRIGGER unavailable_head BEFORE UPDATE ON templates BEGIN SELECT RAISE(ABORT, 'head unavailable'); END;")
    assert.throws(() => store.reviseTemplate(tenant, id, 4, ['changed'], original, actor, 'New name'), /head unavailable/)
    assert.deepEqual(store.templateInfo(tenant, id), metadata)
    assert.equal(store.templateVersions(tenant, id).length, 4)
    assert.deepEqual(Buffer.from(store.template(tenant, id).file), replacement)
  } finally { connection.close() }
})

test('a rename consumes snapshot quota once and stale, unchanged or over-quota names leave history intact', t => {
  const tenant = randomUUID(), creator = randomUUID(), bytes = Buffer.from('same file')
  const store = createStore(':memory:', { quotaBytes: 2 * bytes.length })
  t.after(() => store.close())
  const { id } = store.saveTemplate(tenant, 'First', [], bytes, creator)
  const rename = (baseVersion, name) => store.reviseTemplate(tenant, id, baseVersion, null, null, creator, name)
  assert.equal(rename(1, 'Second').version, 2)
  assert.equal(store.billingUsage(tenant).storageBytes, 2 * bytes.length)
  assert.equal(rename(2, 'Second').version, 2)
  assert.throws(() => rename(1, 'Second'), /newer version/)
  assert.throws(() => rename(2, 'Third'), /storage limit/)
  assert.equal(store.templateInfo(tenant, id).name, 'Second')
  assert.deepEqual(store.templateVersions(tenant, id).map(v => v.name), ['Second', 'First'])
  assert.equal(store.billingUsage(tenant).storageBytes, 2 * bytes.length)
})
