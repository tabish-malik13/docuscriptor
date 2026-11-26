import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isClientSecret } from '../gateway/client-credentials.mjs'
import { uuidPattern } from '../gateway/tenant-authority.mjs'
import { day, openInbox } from './inbox.mjs'
import { createClientTokens, processMessage } from './worker.mjs'

const path = '/api/integrations/whatsapp/webhook'
const id = (v) => typeof v === 'string' && /^\d{1,32}$/.test(v)
const phone = (v) => typeof v === 'string' && /^[1-9]\d{5,14}$/.test(v)
const businessUser = (v) => typeof v === 'string' && /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(v)
const secret = (v, min) => typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= 8192
const array = (v) => Array.isArray(v) ? v : []
export function loadWhatsAppConfig(file) {
  if (!file) return null
  if (!isAbsolute(file)) throw new Error('WHATSAPP_CONFIG_FILE must be an absolute path.')
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('Cannot read the WhatsApp JSON configuration.') }
  if (!raw || typeof raw.version !== 'string' || !/^v[1-9]\d*\.\d+$/.test(raw.version) || !secret(raw.verifyToken, 24) ||
      !secret(raw.appSecret, 24) || raw.verifyToken === raw.appSecret || !array(raw.bindings).length) throw new Error('Invalid WhatsApp webhook configuration.')
  const bindings = new Map()
  for (const [slot, b] of raw.bindings.entries()) {
    if (!b || !id(b.phoneNumberId) || !secret(b.accessToken, 24) || !uuidPattern.test(b.tenantId) || !uuidPattern.test(b.clientId) ||
      !isClientSecret(b.clientSecret) || !array(b.senders).length) throw new Error('Invalid WhatsApp binding configuration.')
    const binding = { ...b, slot, tenantId: b.tenantId.toLowerCase(), clientId: b.clientId.toLowerCase() }
    for (const sender of b.senders) {
      const key = b.phoneNumberId + ':' + sender
      if ((!phone(sender) && !businessUser(sender)) || bindings.has(key)) throw new Error('Invalid or duplicate WhatsApp sender binding.')
      bindings.set(key, binding)
    }
  }
  return { version: raw.version, verifyToken: raw.verifyToken, appSecret: raw.appSecret, bindings }
}

function connectionConfig(connection) {
  const binding = { ...connection, slot: connection.id + ':' + connection.revision }
  return {
    connectionId: connection.id, revision: connection.revision, version: connection.version,
    verifyToken: connection.verifyToken, appSecret: connection.appSecret,
    bindings: new Map(connection.senders.map(sender => [connection.phoneNumberId + ':' + sender, binding])),
  }
}

function incoming(body, config, now) {
  const events = []
  if (body?.object !== 'whatsapp_business_account') return events
  for (const entry of array(body.entry)) for (const { field, value } of array(entry?.changes).filter(Boolean)) {
    if (field !== 'messages' || value?.messaging_product !== 'whatsapp') continue
    const phoneNumberId = value.metadata?.phone_number_id
    if (!id(phoneNumberId)) continue
    for (const msg of array(value.messages)) {
      if (!msg || msg.group_id || msg.context?.group_id) continue
      const phoneBinding = phone(msg.from) && config.bindings.get(phoneNumberId + ':' + msg.from)
      const userBinding = businessUser(msg.from_user_id) && config.bindings.get(phoneNumberId + ':' + msg.from_user_id)
      if (phoneBinding && userBinding && phoneBinding !== userBinding) continue
      const binding = userBinding || phoneBinding
      const from = userBinding ? msg.from_user_id : msg.from
      if (!binding || typeof msg.id !== 'string' || !msg.id.length || msg.id.length > 512 || !/^\d{1,12}$/.test(msg.timestamp)) continue
      const time = Number(msg.timestamp) * 1000
      if (time > now + 300_000 || now - time >= day) continue
      const event = { id: msg.id, phoneNumberId, from, tenantId: binding.tenantId, clientId: binding.clientId, time }
      if (config.connectionId) {
        event.connectionId = config.connectionId
        event.revision = config.revision
      }
      if (msg.type === 'text' && typeof msg.text?.body === 'string' && msg.text.body.length <= 8192) {
        events.push({ ...event, text: msg.text.body })
      }
      if (msg.type === 'document' && id(msg.document?.id) && typeof msg.document.filename === 'string' && msg.document.filename.length <= 255) {
        const caption = msg.document.caption ?? ''
        if (typeof caption === 'string' && caption.length <= 8192) events.push({ ...event, text: caption, media: { id: msg.document.id, filename: msg.document.filename } })
      }
    }
  }
  return events
}

function pollEverySecond(work) {
  const timer = setInterval(work, 1000)
  timer.unref()
  return () => clearInterval(timer)
}

export async function registerWhatsApp(app, {
  configPath = process.env.WHATSAPP_CONFIG_FILE, legacyConfig = loadWhatsAppConfig(configPath), connections,
  storePath, resolveClientToken, templateDeletion = true, fetchImpl = fetch, now = Date.now, schedule = pollEverySecond,
} = {}) {
  if (!legacyConfig && !connections) return
  if (connections?.legacySigningConflict) app.log.warn('The deployment WhatsApp callback requires a dedicated Meta app signing secret.')
  function configuration(connectionId) {
    if (connectionId === undefined) return connections?.legacySigningConflict ? null : legacyConfig
    if (!uuidPattern.test(connectionId)) return null
    const record = connections?.getById(connectionId)
    return record ? connectionConfig(record) : null
  }
  const tokens = createClientTokens(app, resolveClientToken, now)
  const inbox = openInbox(storePath === ':memory:' ? storePath : storePath + '.whatsapp')
  let running, stopPolling, closing = false
  async function drain() {
    if (running || closing) return running
    running = (async () => {
      let row
      while (!closing && (row = inbox.next(now()))) {
        const { connectionId, revision } = row.event
        const config = configuration(connectionId)
        if (!config || config.revision !== revision) {
          inbox.finish(row.key, 'expired')
          continue
        }
        const isCurrent = () => !connectionId || connections.getById(connectionId)?.revision === revision
        await processMessage({ app, inbox, config, fetchImpl, now, tokens, isCurrent, templateDeletion }, row)
      }
    })()
    try { await running } finally { running = undefined }
  }
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json')
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, buffer, done) => done(null, buffer))
    const options = { config: { rateClass: 'webhook' }, logLevel: 'silent' }
    function verify(request, reply) {
      const config = configuration(request.params.connectionId)
      if (!config) return reply.code(404).send()
      const query = request.query
      const digest = (v) => createHash('sha256').update(v).digest()
      if (query['hub.mode'] !== 'subscribe' || typeof query['hub.verify_token'] !== 'string' ||
          !timingSafeEqual(digest(query['hub.verify_token']), digest(config.verifyToken)) ||
          typeof query['hub.challenge'] !== 'string' || query['hub.challenge'].length > 1024) return reply.code(403).send()
      if (config.connectionId) connections.markVerified(config.connectionId, config.revision)
      return reply.type('text/plain').send(query['hub.challenge'])
    }
    function receive(request, reply) {
      const config = configuration(request.params.connectionId)
      if (!config) return reply.code(404).send()
      const supplied = request.headers['x-hub-signature-256']
      if (!Buffer.isBuffer(request.body) || typeof supplied !== 'string' || !/^sha256=[a-f\d]{64}$/.test(supplied)) return reply.code(403).send()
      const expected = createHmac('sha256', config.appSecret).update(request.body).digest()
      if (!timingSafeEqual(expected, Buffer.from(supplied.slice(7), 'hex'))) return reply.code(403).send()
      let body
      try { body = JSON.parse(request.body) } catch { return reply.code(400).send() }
      const received = now()
      const events = incoming(body, config, received)
      if (events.length && !inbox.enqueue(events, received)) return reply.code(503).header('Retry-After', '5').send()
      return reply.code(200).send()
    }
    const paths = []
    if (legacyConfig) paths.push(path)
    if (connections) paths.push(path + '/:connectionId')
    for (const route of paths) {
      webhook.get(route, options, verify)
      webhook.post(route, { ...options, bodyLimit: 3 * 1024 * 1024 }, receive)
    }
  })
  app.addHook('onReady', async () => {
    stopPolling = schedule(() => drain().catch(() => app.log.error('WhatsApp inbox unavailable')))
  })
  app.addHook('preClose', async () => { closing = true; stopPolling?.(); await running })
  app.addHook('onClose', async () => inbox.close())
}
