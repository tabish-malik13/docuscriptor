import { commandFor, CommandError, present, textReply } from './commands.mjs'
import { createMetaApi, RemoteFailure } from './meta.mjs'
import { day } from './inbox.mjs'

const denied = 'Your integration does not have access to this command. Contact your workspace administrator.'
class ConnectionChanged extends Error {}

async function exchangeToken(app, binding, scope) {
  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  if (scope) body.set('scope', scope)
  const response = await app.inject({ method: 'POST', url: '/api/oauth/token', headers: {
    authorization: 'Basic ' + Buffer.from(binding.clientId + ':' + binding.clientSecret).toString('base64'),
    'content-type': 'application/x-www-form-urlencoded', 'x-tenant-id': binding.tenantId,
  }, payload: body.toString() })
  if (response.statusCode === 429 || response.statusCode >= 500) throw new RemoteFailure(response.statusCode, Number(response.headers['retry-after']) || 0)
  if (response.statusCode !== 200) throw new CommandError(denied)
  const { access_token: token, expires_in: seconds } = response.json()
  if (!token || typeof token !== 'string' || !Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Invalid access token response')
  return { token, seconds }
}

export function createClientTokens(app, resolveClientToken, now) {
  if (typeof resolveClientToken !== 'function') throw new Error('WhatsApp requires the gateway token verifier.')
  const cache = new Map()
  function active(binding, token, scope) {
    const client = resolveClientToken(token)
    return client?.id === binding.clientId && client.tenantId === binding.tenantId &&
      (!scope || scope.split(' ').every((s) => client.scopes.includes(s)))
  }
  return {
    active,
    async get(binding, scope) {
      // Managed slots include the connection revision so edited credentials cannot reuse an earlier token.
      const key = binding.slot + ':' + (scope || '')
      const previous = cache.get(key)
      cache.delete(key)
      if (previous && previous.until > now() && active(binding, previous.token, scope)) {
        cache.set(key, previous)
        return previous.token
      }
      const { token, seconds } = await exchangeToken(app, binding, scope)
      if (!active(binding, token, scope)) throw new CommandError(denied)
      if (cache.size >= 256) cache.delete(cache.keys().next().value)
      cache.set(key, { token, until: now() + Math.max(0, seconds - 15) * 1000 })
      return token
    },
  }
}

async function gateway(app, binding, token, command) {
  const response = await app.inject({ method: command.method || 'GET', url: command.path,
    headers: { authorization: 'Bearer ' + token, 'x-tenant-id': binding.tenantId },
    payload: command.payload })
  if (response.statusCode === 429 || response.statusCode >= 500) throw new RemoteFailure(response.statusCode, Number(response.headers['retry-after']) || 0)
  if (response.statusCode >= 400) {
    const message = response.json().message
    throw new CommandError(typeof message === 'string' ? message.slice(0, 500) : 'The workspace rejected this command.')
  }
  return present(command, response)
}

export async function processMessage({ app, inbox, config, fetchImpl, now, tokens, isCurrent }, row) {
  const { event, key } = row
  const binding = config.bindings.get(event.phoneNumberId + ':' + event.from)
  if (!binding || binding.tenantId !== event.tenantId || binding.clientId !== event.clientId || now() - event.time >= day) {
    return inbox.finish(key, 'expired')
  }
  // After a restart the provider may already have accepted this send. Never send it twice.
  if (row.stage === 'sending') {
    app.log.warn({ eventKey: key }, 'WhatsApp delivery outcome unknown')
    return inbox.finish(key, 'uncertain')
  }
  function requireCurrent() { if (!isCurrent()) throw new ConnectionChanged() }
  const meta = createMetaApi(config.version, binding, (url, options) => {
    requireCurrent()
    return fetchImpl(url, options)
  })
  function callGateway(token, command) {
    requireCurrent()
    return gateway(app, binding, token, command)
  }
  let stage = row.stage, result = row.result
  function checkpoint(next, value = null) {
    inbox.stage(key, next, value)
    stage = next
    result = value
  }
  let token, scope
  async function prepare() {
    let command
    try { command = commandFor(event) } catch (error) {
      if (!(error instanceof CommandError)) throw error
      command = textReply(error.message)
    }
    scope = command.scope
    requireCurrent()
    token = await tokens.get(binding, scope)
    if (stage === 'executing') {
      checkpoint('ready', textReply('Processing was interrupted. Check your workspace history or templates before sending this command again.'))
    }
    if (stage === 'pending' && command.method) {
      if (command.upload) Object.assign(command.payload, await meta.download(event.media))
      checkpoint('executing')
      try {
        const reply = await callGateway(token, command)
        checkpoint('ready', reply)
      } catch (error) {
        // Gateway admission controls return Retry-After on 503 before any mutation. Other 5xx responses can have created a job.
        if (error.status === 429 || (error.status === 503 && error.delay > 0)) checkpoint('pending')
        throw error
      }
    }
    const reply = stage === 'ready' ? result : command
    return reply.text !== undefined ? reply : callGateway(token, reply)
  }
  async function deliver() {
    const textMessage = (value) => ({ type: 'text', text: { body: value.slice(0, 4000), preview_url: false } })
    let content
    try {
      const reply = await prepare()
      if (!tokens.active(binding, token, scope)) throw new CommandError(denied)
      content = reply.bytes ? await meta.upload(reply) : textMessage(reply.text)
      if (reply.bytes && !tokens.active(binding, token, scope)) throw new CommandError(denied)
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      content = textMessage(token && !tokens.active(binding, token, scope) ? denied : error.message)
    }
    const previousStage = stage, previousResult = result
    checkpoint('sending')
    try { await meta.send(event.from, content) } catch (error) {
      if (error.status === 429) checkpoint(previousStage, previousResult)
      throw error
    }
    inbox.finish(key, 'sent')
  }
  try { await deliver() } catch (error) {
    if (error instanceof ConnectionChanged) return inbox.finish(key, 'expired')
    const retry = stage !== 'sending' && row.attempts < 8
    app.log.warn({ eventKey: key, stage, status: error.status || null, retry }, 'WhatsApp operation incomplete')
    if (retry) {
      const seconds = Math.max(Math.min(900, 2 ** (row.attempts + 1)), Math.min(3600, error.delay || 0))
      inbox.defer(key, now() + seconds * 1000)
    } else inbox.finish(key, stage === 'sending' ? 'uncertain' : 'failed')
  }
}
