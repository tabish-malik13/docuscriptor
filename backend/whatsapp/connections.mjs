import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { problem } from '../gateway/store.mjs'

function encryptionKey(path, configuredKey, hasProtectedData) {
  if (configuredKey) {
    const key = Buffer.from(configuredKey, 'base64')
    if (key.length !== 32 || key.toString('base64') !== configuredKey) throw new Error('WHATSAPP_ENCRYPTION_KEY must encode 32 bytes in standard base64.')
    return key
  }
  if (path === ':memory:') return randomBytes(32)
  const keyPath = path + '.whatsapp.key'
  function read() {
    const key = readFileSync(keyPath)
    if (key.length !== 32) throw new Error('The stored WhatsApp encryption key is invalid.')
    return key
  }
  try { return read() } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (hasProtectedData) throw new Error('Restore the WhatsApp encryption key from the gateway backup.')
  }
  const temporary = keyPath + '.' + randomUUID()
  writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx', flush: true })
  try {
    // Publish a complete key without replacing a key created by another startup.
    linkSync(temporary, keyPath)
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  finally { unlinkSync(temporary) }
  return read()
}

const changed = () => problem(409, 'The WhatsApp connection changed. Reload its settings and try again.')
const associatedData = row => Buffer.from(JSON.stringify([row.tenantId, row.id, row.revision, row.phoneNumberId]))

export function openWhatsAppConnections({ storePath, configuredKey = process.env.WHATSAPP_ENCRYPTION_KEY, legacyConfig }) {
  const path = storePath === ':memory:' ? storePath : storePath + '.whatsapp-connections.sqlite'
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  const legacyBindings = Array.from(legacyConfig?.bindings.values() ?? [])
  const reservedNumbers = new Set(legacyBindings.map(binding => binding.phoneNumberId))
  let key, marker
  const fingerprint = secret => createHmac('sha256', key).update('WhatsApp signing secret\0').update(secret).digest()
  function decode(row) {
    if (!row) return null
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.iv)
      decipher.setAAD(associatedData(row))
      decipher.setAuthTag(row.tag)
      const data = JSON.parse(Buffer.concat([decipher.update(row.data), decipher.final()]).toString('utf8'))
      return { ...data, id: row.id, revision: row.revision, tenantId: row.tenantId, phoneNumberId: row.phoneNumberId,
        updatedAt: row.updatedAt, verifiedAt: row.verifiedAt }
    } catch { throw new Error('Cannot decrypt the WhatsApp connection. Check the gateway encryption key and restore from backup if needed.') }
  }
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    db.exec(`
      PRAGMA trusted_schema=OFF;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS connections (
        tenantId TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, revision TEXT NOT NULL, phoneNumberId TEXT NOT NULL,
        updatedAt TEXT NOT NULL, verifiedAt TEXT, iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS signing_keys (
        fingerprint BLOB NOT NULL, tenantId TEXT NOT NULL, PRIMARY KEY(fingerprint,tenantId)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS key_check (id INTEGER PRIMARY KEY CHECK(id=1), marker BLOB NOT NULL) STRICT;
    `)
    const sample = db.prepare('SELECT * FROM connections LIMIT 1').get()
    const check = db.prepare('SELECT marker FROM key_check WHERE id=1').get()
    const hasProtectedData = !!sample || !!db.prepare('SELECT 1 FROM signing_keys LIMIT 1').get()
    key = encryptionKey(storePath, configuredKey, hasProtectedData)
    marker = createHmac('sha256', key).update('WhatsApp connections key check').digest()
    if (hasProtectedData && check && !marker.equals(check.marker)) throw new Error('Cannot decrypt the WhatsApp configuration. Restore the original gateway encryption key.')
    decode(sample)
    if (hasProtectedData && !check) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const addSigner = db.prepare('INSERT OR IGNORE INTO signing_keys VALUES(?,?)')
        for (const row of db.prepare('SELECT * FROM connections').iterate()) addSigner.run(fingerprint(decode(row).appSecret), row.tenantId)
        db.prepare('INSERT OR REPLACE INTO key_check VALUES(1,?)').run(marker)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } else if (!hasProtectedData && check) {
      db.exec('DELETE FROM key_check')
    }
  } catch (error) { db.close(); throw error }
  const forTenant = db.prepare('SELECT * FROM connections WHERE tenantId=?')
  const byId = db.prepare('SELECT * FROM connections WHERE id=?')
  const otherSigner = db.prepare('SELECT 1 FROM signing_keys WHERE fingerprint=? AND tenantId!=? LIMIT 1')
  const legacySigner = legacyConfig?.appSecret ? fingerprint(legacyConfig.appSecret) : null
  const legacySigningConflict = !!legacySigner && !!db.prepare('SELECT 1 FROM signing_keys WHERE fingerprint=? LIMIT 1').get(legacySigner)
  function deploymentConflict(connection) {
    return reservedNumbers.has(connection.phoneNumberId) || (!!legacySigner && legacySigner.equals(fingerprint(connection.appSecret)))
  }
  return {
    close() { db.close(); key.fill(0) },
    legacySigningConflict,
    deploymentManagedNumbers(tenantId) {
      return new Set(legacyBindings.filter(binding => binding.tenantId === tenantId).map(binding => binding.phoneNumberId)).size
    },
    deploymentConflict,
    getByTenant(tenantId) { return decode(forTenant.get(tenantId)) },
    getById(id) {
      const connection = decode(byId.get(id))
      if (!connection || deploymentConflict(connection) || otherSigner.get(fingerprint(connection.appSecret), connection.tenantId)) return null
      return connection
    },
    markVerified(id, revision) {
      db.prepare('UPDATE connections SET verifiedAt=? WHERE id=? AND revision=?').run(new Date().toISOString(), id, revision)
    },
    save(tenantId, input, validateClient) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const previous = decode(forTenant.get(tenantId))
        if (input.revision !== (previous?.revision ?? null)) throw changed()
        if (reservedNumbers.has(input.phoneNumberId)) throw problem(409, 'This business phone number is managed by the deployment administrator.')
        const clientId = input.clientId.toLowerCase()
        const clientSecret = input.clientSecret ?? (clientId === previous?.clientId ? previous.clientSecret : undefined)
        const appSecret = input.appSecret ?? previous?.appSecret
        const accessToken = input.accessToken ?? previous?.accessToken
        if (!appSecret || !accessToken || !clientSecret) throw problem(400, 'Enter the Meta credentials and the selected workspace API client secret.')
        validateClient(clientId, clientSecret)
        // Meta signs the body, without the callback URL. A signing key once known by
        // another tenant cannot authenticate a different organization's callback.
        const signer = fingerprint(appSecret)
        if (legacySigner?.equals(signer) || otherSigner.get(signer, tenantId)) throw problem(409, 'Use an independent Meta app signing secret for this organization.')
        db.prepare('INSERT OR IGNORE INTO key_check VALUES(1,?)').run(marker)
        db.prepare('INSERT OR IGNORE INTO signing_keys(fingerprint,tenantId) VALUES(?,?)').run(signer, tenantId)
        const rotate = !previous || input.rotateVerifyToken === true
        const verifyToken = rotate ? randomBytes(32).toString('base64url') : previous.verifyToken
        const data = { version: input.version, senders: input.senders, clientId, clientSecret, accessToken, appSecret, verifyToken }
        const id = previous?.id ?? randomUUID(), revision = randomUUID(), updatedAt = new Date().toISOString()
        const verifiedAt = rotate || appSecret !== previous.appSecret || input.phoneNumberId !== previous.phoneNumberId ? null : previous.verifiedAt
        const row = { tenantId, id, revision, phoneNumberId: input.phoneNumberId, updatedAt, verifiedAt }
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(associatedData(row))
        const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
        db.prepare(`INSERT INTO connections (tenantId,id,revision,phoneNumberId,updatedAt,verifiedAt,iv,tag,data)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenantId) DO UPDATE SET
          revision=excluded.revision,phoneNumberId=excluded.phoneNumberId,updatedAt=excluded.updatedAt,verifiedAt=excluded.verifiedAt,
          iv=excluded.iv,tag=excluded.tag,data=excluded.data`).run(tenantId, id, revision, input.phoneNumberId, updatedAt, verifiedAt, iv, cipher.getAuthTag(), bytes)
        db.exec('COMMIT')
        return { connection: { ...row, ...data }, issuedVerifyToken: rotate ? verifyToken : undefined }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    remove(tenantId, revision) {
      if (!db.prepare('DELETE FROM connections WHERE tenantId=? AND revision=?').run(tenantId, revision).changes) throw changed()
    },
  }
}
