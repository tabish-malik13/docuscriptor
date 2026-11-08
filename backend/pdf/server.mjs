import { buildPdfApp } from './app.mjs'
import { start } from '../shared/http-service.mjs'

await start(buildPdfApp(), Number(process.env.PORT || 4002))
