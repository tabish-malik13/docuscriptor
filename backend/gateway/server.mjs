import { buildGatewayApp } from './app.mjs'
import { start } from '../shared/http-service.mjs'

process.umask(0o077)
await start(await buildGatewayApp(), Number(process.env.PORT || 4000))
