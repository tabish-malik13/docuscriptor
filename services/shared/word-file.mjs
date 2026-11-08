import yauzl from 'yauzl'
import { InputError } from './http-service.mjs'

const maxParts = 400
const maxExpandedBytes = 24 * 1024 * 1024
const documentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

export async function validateWordFile(bytes) {
  try {
    await new Promise((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
        if (error) return reject(error)
        if (zip.entryCount > maxParts) return reject(new Error('Too many parts'))
        const entries = new Set()
        let expandedBytes = 0
        let types = ''
        zip.on('error', reject)
        zip.on('end', () => {
          if (entries.has('word/document.xml') && types.includes(documentType) &&
            !/macroEnabled|vbaProject|activeX|oleObject/i.test(types)) resolve()
          else reject(new Error('Unexpected document type'))
        })
        zip.on('entry', (entry) => {
          const name = entry.fileName.toLowerCase()
          expandedBytes += entry.uncompressedSize
          if (entries.has(name) || expandedBytes > maxExpandedBytes ||
            /(^|\/)(activex|embeddings)\/|vbaproject|vbadata/i.test(name) ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            (name === '[content_types].xml' && entry.uncompressedSize > 128 * 1024)) {
            return reject(new Error('Unsupported ZIP entry'))
          }
          entries.add(name)
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError)
            stream.on('error', reject)
            if (name === '[content_types].xml') {
              stream.setEncoding('utf8')
              stream.on('data', (chunk) => { types += chunk })
            } else {
              stream.resume()
            }
            stream.on('end', () => zip.readEntry())
          })
        })
        zip.readEntry()
      })
    })
  } catch {
    throw new InputError('Choose a valid DOCX without macros or embedded objects.')
  }
}
