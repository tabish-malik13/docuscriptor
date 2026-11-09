import Fastify from 'fastify'

import { InputError } from '../../shared/problems.mjs'
export { InputError } from '../../shared/problems.mjs'

export function createService({ logger = { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.authorization'] } } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: 6 * 1024 * 1024,
    requestTimeout: 30_000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  })
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InputError) return reply.code(422).send({ message: error.message })
    if (error.validation) return reply.code(400).send({ message: 'Check the file type and required fields. Runtime values must be text.' })
    if (error.publicMessage && error.statusCode >= 400 && error.statusCode <= 599) {
      return reply.code(error.statusCode).send({ message: error.publicMessage })
    }
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ message: error.publicMessage || (error.statusCode === 413 ? 'The upload is too large.' : 'The request could not be accepted.') })
    }
    request.log.error({ errorName: error.name, errorCode: error.code }, 'Request failed')
    return reply.code(500).send({ message: 'The service could not complete the request.' })
  })
  return app
}

export async function start(app, port) {
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await app.listen({ host: process.env.HOST || '127.0.0.1', port })
}
