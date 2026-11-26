import Fastify from 'fastify'

export class InputError extends Error {}

export function createService({ logger = {}, trustProxy = false } = {}) {
  const app = Fastify({
    logger: logger === false ? false : {
      level: process.env.LOG_LEVEL || 'info', ...logger,
      serializers: {
        ...logger.serializers,
        // Route templates retain useful request context without logging credentials,
        // query strings, document IDs or user-supplied paths.
        req(request) { return { method: request.method, route: request.routeOptions?.url, remoteAddress: request.raw?.socket.remoteAddress } },
        // Parser errors may carry the raw HTTP packet, including credential headers.
        err(error) { return { type: error.name, code: error.code } },
      },
    },
    trustProxy,
    frameworkErrors(error, _request, reply) {
      return reply.code(error.statusCode || 500).header('Cache-Control', 'no-store').send({ message: 'The request could not be accepted.' })
    },
    bodyLimit: 6 * 1024 * 1024,
    requestTimeout: 30_000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  })
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
  })
  // Fastify's default 404 message and log line both include the full request URL.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found.' }))
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
