import { buildDocxApp } from './app.mjs'
import { start } from '../shared/http-service.mjs'

await start(buildDocxApp(), Number(process.env.PORT || 4001))
