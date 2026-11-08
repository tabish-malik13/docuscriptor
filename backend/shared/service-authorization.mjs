import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export function requireSecret(secret, name) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error(name + ' must contain at least 32 bytes. Generate it with openssl rand -hex 32.')
  }
  return secret
}

const digest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const signature = (payload, secret) => createHmac('sha256', secret).update(payload).digest()

// A separate key per service limits which requests a compromised service can forge.
export function signServiceRequest(secret, audience, subject, path, body, tenantId) {
  const payload = Buffer.from(JSON.stringify({
    iss: 'gateway', aud: audience, sub: subject, tenant: tenantId, method: 'POST', path,
    hash: digest(body), exp: Math.floor(Date.now() / 1000) + 30, nonce: randomUUID(),
  })).toString('base64url')
  return 'Bearer ' + payload + '.' + signature(payload, secret).toString('base64url')
}

export function serviceAuthorization(secret, audience) {
  requireSecret(secret, audience.toUpperCase() + '_SERVICE_SECRET')
  const seen = new Map()
  return async (request, reply) => {
    try {
      const header = request.headers.authorization || ''
      if (!header.startsWith('Bearer ') || header.length > 4096) throw new Error('Missing assertion')
      const [payload, signed, extra] = header.slice(7).split('.')
      if (!payload || !signed || extra !== undefined) throw new Error('Malformed assertion')
      const received = Buffer.from(signed, 'base64url')
      const expected = signature(payload, secret)
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('Invalid signature')
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      const now = Math.floor(Date.now() / 1000)
      for (const [nonce, expiry] of seen) if (expiry <= now) seen.delete(nonce)
      if (claims.iss !== 'gateway' || claims.aud !== audience || claims.method !== request.method ||
        claims.path !== request.url || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 ||
        typeof claims.tenant !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claims.tenant) ||
        !Number.isInteger(claims.exp) || claims.exp <= now || claims.exp > now + 30 ||
        typeof claims.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(claims.nonce) ||
        claims.hash !== digest(request.body) || seen.has(claims.nonce)) throw new Error('Invalid assertion')
      if (seen.size >= 5000) return reply.code(503).send({ message: 'The processing service is busy.' })
      seen.set(claims.nonce, claims.exp)
      request.subject = claims.sub
      request.tenantId = claims.tenant
    } catch {
      return reply.code(401).send({ message: 'A valid gateway authorization is required.' })
    }
  }
}
