import rateLimit from '@fastify/rate-limit'
import { createService, start } from '../shared/http-service.mjs'
import { registerDocumentRoutes } from './document-routes.mjs'

const app = createService()
app.decorateRequest('subject', null)
await app.register(rateLimit, {
  global: false,
  hook: 'preParsing',
  max: 20,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.subject || request.ip,
})

app.get('/api/health', async () => ({ status: 'ok' }))
registerDocumentRoutes(app)

await start(app, Number(process.env.PORT || 4000))
