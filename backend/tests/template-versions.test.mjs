import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import PizZip from 'pizzip'
import { fixture, invoiceValues } from './helpers.mjs'
import { starterTemplate } from '../docx/starter-templates.mjs'
import { createStore } from '../gateway/store.mjs'

const upload = bytes => ({ filename: 'layout.docx', file: bytes.toString('base64') })
const request = (f, person, method, url, payload) => f.gateway.inject({ headers: person.headers, method, url, payload })
async function create(f, person, bytes) {
  const response = await request(f, person, 'POST', '/api/templates', { name: 'Saved layout', ...upload(bytes) })
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(response.json().version, 1)
  return response.json().id
}

test('PATCH renames and replaces a template while preserving the reviewed versions across restarts', async t => {
  const f = await fixture(t), creator = f.principal(), viewer = f.principal('viewer', creator.tenantId)
  const admin = f.principal('admin', creator.tenantId), colleague = f.principal('operator', creator.tenantId)
  const first = await starterTemplate('invoice'), second = await starterTemplate('letter')
  const id = await create(f, creator, first), path = '/api/templates/' + id
  const initial = await request(f, viewer, 'GET', path)
  assert.equal(initial.statusCode, 200)
  assert.ok(initial.json().fields.includes('customer_name'))
  assert.equal(initial.json().name, 'Saved layout')
  assert.equal(initial.json().file, undefined)
  const rename = { baseVersion: 1, name: '  Billing  ' }
  for (const person of [colleague, viewer]) {
    assert.equal((await request(f, person, 'PATCH', path, rename)).statusCode, 403)
  }
  const renamed = await request(f, creator, 'PATCH', path, rename)
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.equal(renamed.json().name, 'Billing')
  assert.equal(renamed.json().version, 2)
  assert.deepEqual(renamed.json().fields, initial.json().fields)
  const sameName = await request(f, creator, 'PATCH', path, { ...rename, baseVersion: 2 })
  assert.equal(sameName.statusCode, 200, sameName.body)
  assert.equal(sameName.json().version, 2)
  assert.equal((await request(f, creator, 'PATCH', path, rename)).statusCode, 409)
  const revised = await request(f, admin, 'PATCH', path, { baseVersion: 2, name: 'Letter', ...upload(second) })
  assert.equal(revised.statusCode, 200, revised.body)
  assert.equal(revised.json().id, id)
  assert.equal(revised.json().version, 3)
  assert.ok(revised.json().fields.includes('sender_name'))
  await f.restart()
  const info = (await request(f, viewer, 'GET', path)).json()
  assert.equal(info.name, 'Letter')
  assert.equal(info.version, 3)
  assert.equal(info.createdBy, creator.user.id)
  assert.deepEqual(info.fields, revised.json().fields)
  assert.equal(info.file, undefined)
  for (const [version, name, bytes] of [[1, 'Saved layout', first], [2, 'Billing', first], [3, 'Letter', second]]) {
    const download = await request(f, viewer, 'GET', path + '/versions/' + version + '/download')
    assert.equal(download.statusCode, 200)
    assert.equal(download.headers['x-template-version'], String(version))
    assert.ok(download.headers['content-disposition'].includes('filename="' + name + '.docx"'))
    assert.deepEqual(download.rawPayload, bytes)
  }
})

test('PATCH requires a version and a valid change and rolls back a name if its DOCX is invalid', async t => {
  const f = await fixture(t), creator = f.principal()
  const first = await starterTemplate('invoice'), next = await starterTemplate('letter')
  const id = await create(f, creator, first), path = '/api/templates/' + id
  const incomplete = [
    { baseVersion: 1 }, { name: 'New label' }, { baseVersion: 0, name: 'New label' },
    { baseVersion: 1, name: '   ' }, { baseVersion: 1, filename: 'layout.docx' },
    { baseVersion: 1, name: 'New label', file: next.toString('base64') },
  ]
  for (const payload of incomplete) {
    assert.equal((await request(f, creator, 'PATCH', path, payload)).statusCode, 400)
  }
  const invalidFile = { baseVersion: 1, name: 'Invalid replacement', ...upload(Buffer.from('invalid file')) }
  assert.equal((await request(f, creator, 'PATCH', path, invalidFile)).statusCode, 422)
  const previous = (await request(f, creator, 'GET', path)).json()
  assert.equal(previous.version, 1)
  assert.equal(previous.name, 'Saved layout')
  const fileOnly = await request(f, creator, 'PATCH', path, { baseVersion: 1, ...upload(next) })
  assert.equal(fileOnly.statusCode, 200, fileOnly.body)
  assert.equal(fileOnly.json().name, previous.name)
  assert.equal(fileOnly.json().version, 2)
})

test('revisions preserve the same template, enforce write ownership, and return the exact version with each download', async t => {
  const f = await fixture(t), creator = f.principal(), admin = f.principal('admin', creator.tenantId)
  const colleague = f.principal('operator', creator.tenantId), viewer = f.principal('viewer', creator.tenantId), outside = f.principal('owner')
  const first = await starterTemplate('invoice'), second = await starterTemplate('letter')
  const id = await create(f, creator, first), path = '/api/templates/' + id
  const revision = { baseVersion: 1, ...upload(second) }
  assert.equal((await request(f, colleague, 'POST', path + '/versions', revision)).statusCode, 403)
  assert.equal((await request(f, viewer, 'POST', path + '/versions', revision)).statusCode, 403)
  assert.equal((await request(f, outside, 'POST', path + '/versions', revision)).statusCode, 404)
  const edited = await request(f, admin, 'POST', path + '/versions', revision)
  assert.equal(edited.statusCode, 201, edited.body)
  assert.equal(edited.json().id, id)
  assert.equal(edited.json().name, 'Saved layout')
  assert.equal(edited.json().version, 2)
  assert.ok(edited.json().fields.includes('sender_name'))
  assert.equal((await request(f, creator, 'POST', path + '/versions', revision)).statusCode, 409)
  await f.restart()
  const history = await request(f, viewer, 'GET', path + '/versions')
  assert.deepEqual(history.json().items.map(v => [v.version, v.createdBy]), [[2, admin.user.id], [1, creator.user.id]])
  for (const [url, bytes, version] of [
    [path + '/download',second,2], ['/api/templates/mine/' + id + '/download',second,2],
    [path + '/versions/1/download',first,1], [path + '/versions/2/download',second,2],
  ]) {
    const response = await request(f, creator, 'GET', url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['x-template-version'], String(version))
    assert.deepEqual(response.rawPayload, bytes)
  }
  for (const suffix of ['/versions','/versions/1/download','/versions/2/download']) {
    assert.equal((await request(f, outside, 'GET', path + suffix)).statusCode, 404)
  }
  assert.equal((await request(f, creator, 'GET', path + '/versions/3/download')).statusCode, 404)
  for (const url of ['/api/templates','/api/templates/mine']) {
    const listed = (await request(f, creator, 'GET', url)).json().items
    assert.deepEqual(listed.map(t => [t.id, t.version, t.createdBy]), [[id, 2, creator.user.id]])
  }
  assert.equal((await request(f, creator, 'DELETE', path)).statusCode, 204)
  assert.equal((await request(f, viewer, 'GET', path + '/versions/1/download')).statusCode, 404)
})

test('one concurrent writer wins and invalid content or a demotion never creates a version', async t => {
  const options = {}, f = await fixture(t, options), creator = f.principal(), admin = f.principal('admin', creator.tenantId)
  const original = await starterTemplate('invoice'), edited = await starterTemplate('letter')
  const id = await create(f, creator, original), path = '/api/templates/' + id + '/versions'
  const revision = { baseVersion: 1, ...upload(edited) }
  assert.equal((await request(f, creator, 'POST', path, { ...revision, file: Buffer.from('invalid').toString('base64') })).statusCode, 422)
  options.onServiceResult = () => f.setRole(admin, 'operator')
  assert.equal((await request(f, admin, 'POST', path, revision)).statusCode, 403)
  options.onServiceResult = null
  const results = await Promise.all([request(f, creator, 'POST', path, revision), request(f, creator, 'POST', path, revision)])
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409])
  assert.deepEqual((await request(f, creator, 'GET', path)).json().items.map(v => v.version), [2, 1])
})

test('a saved batch keeps its reviewed template version when a later edit changes its fields', async t => {
  const f = await fixture(t), creator = f.principal()
  const id = await create(f, creator, await starterTemplate('invoice')), path = '/api/templates/' + id
  const draft = { savedTemplateId: id, format: 'DOCX', rows: ['First','Second'].map(name => ({
    name, values: { ...invoiceValues(), customer_name: name },
  })) }
  const start = await request(f, creator, 'POST', '/api/batches', draft)
  assert.equal(start.statusCode, 201, start.body)
  assert.equal(start.json().savedTemplateVersion, 1)
  const batch = '/api/batches/' + start.json().id
  assert.equal((await request(f, creator, 'POST', batch + '/next')).json().ready, 1)
  assert.equal((await request(f, creator, 'POST', path + '/versions', { baseVersion: 1, ...upload(await starterTemplate('letter')) })).statusCode, 201)
  await f.restart()
  assert.equal((await request(f, creator, 'POST', batch + '/next')).json().ready, 2)
  const archive = new PizZip((await request(f, creator, 'GET', batch + '/download')).rawPayload)
  for (const { name } of draft.rows) {
    const xml = new PizZip(archive.file(name + '.docx').asNodeBuffer()).file('word/document.xml').asText()
    assert.ok(xml.includes(name))
  }
  assert.equal((await request(f, creator, 'POST', '/api/batches', draft)).statusCode, 422)
})

test('upgrading a v4 store preserves prior bytes, pins queued batches and charges retained versions until deletion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docuscripter-version-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'store.sqlite'), tenant = randomUUID(), user = randomUUID()
  const first = Buffer.from('original'), second = Buffer.from('revision')
  const quotaBytes = first.length + second.length
  let store = createStore(path)
  const { id } = store.saveTemplate(tenant, 'Existing template', ['first'], first, user)
  const batch = store.createBatch(tenant, user, { savedTemplateId: id, savedTemplateVersion: 1, templateName: 'Existing template',
    format: 'DOCX', rows: [{ name: 'file.docx', values: {} }] })
  store.close()
  const db = new DatabaseSync(path)
  try {
    db.exec(`DROP TABLE template_versions;
      ALTER TABLE templates DROP COLUMN updated_by;
      ALTER TABLE templates DROP COLUMN updated;
      ALTER TABLE templates DROP COLUMN version;
      ALTER TABLE batches DROP COLUMN saved_template_version;
      PRAGMA user_version=4;`)
  } finally { db.close() }
  store = createStore(path, { quotaBytes })
  t.after(() => store.close())
  assert.equal(store.batch(tenant, user, batch.id).savedTemplateVersion, 1)
  store.deleteBatch(tenant, user, batch.id)
  assert.deepEqual(Buffer.from(store.template(tenant, id).file), first)
  assert.equal(store.reviseTemplate(tenant, id, 1, ['second'], second, user).version, 2)
  assert.throws(() => store.reviseTemplate(tenant, id, 2, [], Buffer.from('third'), user), /storage limit/)
  assert.equal(store.templateInfo(tenant, id).version, 2)
  assert.throws(() => store.saveTemplate(tenant, 'more', [], Buffer.from('!'), user), /storage limit/)
  assert.equal(store.deleteTemplate(tenant, id), true)
  assert.equal(store.saveTemplate(tenant, 'reclaimed', [], Buffer.alloc(quotaBytes), user).version, 1)
})
