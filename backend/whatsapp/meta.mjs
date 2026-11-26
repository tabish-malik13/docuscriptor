import { createHash } from 'node:crypto'
import { maxFileBytes, maxOutputBytes, docxType, pdfType } from '../shared/document-http.mjs'
import { CommandError } from './commands.mjs'

export class RemoteFailure extends Error {
  constructor(status, delay = 0) {
    super('Remote request failed')
    this.status = status
    this.delay = delay
  }
}

async function bounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new CommandError('This file exceeds the size limit.')
  }
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > limit) throw new CommandError('This file exceeds the size limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

export function createMetaApi(version, binding, fetchImpl) {
  const origin = 'https://graph.facebook.com/' + version + '/'
  const auth = 'Bearer ' + binding.accessToken
  async function request(url, options = {}, limit = 64 * 1024) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { ...options.headers, Authorization: auth } })
    if (!response.ok) {
      await response.body?.cancel()
      throw new RemoteFailure(response.status, Number(response.headers.get('retry-after')) || 0)
    }
    return bounded(response, limit)
  }
  return {
    async download(media) {
      const metadata = JSON.parse(await request(origin + media.id + '?phone_number_id=' + binding.phoneNumberId))
      const size = Number(metadata.file_size)
      if (metadata.id !== media.id || !/^\d+$/.test(String(metadata.file_size)) || !Number.isSafeInteger(size) || size < 1 || size > maxFileBytes) {
        throw new CommandError('Use a document of 4 MiB or smaller.')
      }
      const url = new URL(metadata.url)
      if (url.origin !== 'https://lookaside.fbsbx.com' || url.username || url.password || !url.pathname.startsWith('/whatsapp_business/attachments/')) {
        throw new CommandError('Meta returned an unsupported media address.')
      }
      const bytes = await request(url.href, {}, maxFileBytes)
      const digest = createHash('sha256').update(bytes).digest()
      if (bytes.length !== size || ![digest.toString('hex'), digest.toString('base64')].includes(metadata.sha256)) {
        throw new CommandError('The file failed its integrity check. Attach the file again.')
      }
      return { filename: media.filename, file: bytes.toString('base64') }
    },
    async upload({ bytes, filename, type }) {
      if (![docxType, pdfType].includes(type) || !bytes?.length || bytes.length > maxOutputBytes) throw new Error('Invalid outgoing artifact')
      const form = new FormData()
      form.append('messaging_product', 'whatsapp')
      form.append('type', type)
      form.append('file', new Blob([bytes], { type }), filename)
      const data = JSON.parse(await request(origin + binding.phoneNumberId + '/media', { method: 'POST', body: form }))
      if (typeof data.id !== 'string' || !/^\d{1,32}$/.test(data.id)) throw new Error('Invalid uploaded media ID')
      return { type: 'document', document: { id: data.id, filename } }
    },
    async send(to, content) {
      await request(origin + binding.phoneNumberId + '/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', [to.includes('.') ? 'recipient' : 'to']: to, ...content }),
      })
    },
  }
}
