import { InputError } from '../../shared/problems.mjs'
import { Buffer } from 'node:buffer'

export const maxFileBytes = 4 * 1024 * 1024
export const maxOutputBytes = 16 * 1024 * 1024
export const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const pdfType = 'application/pdf'

export const uploadFields = {
  filename: { type: 'string', minLength: 1, maxLength: 255 },
  file: { type: 'string', minLength: 4, maxLength: Math.ceil(maxFileBytes / 3) * 4 },
}

export const uploadSchema = {
  type: 'object', required: ['filename', 'file'], additionalProperties: false, properties: uploadFields,
}

export const docxSchema = {
  type: 'object',
  required: ['values'],
  additionalProperties: false,
  oneOf: [
    { required: ['templateId'], not: { anyOf: [{ required: ['file'] }, { required: ['filename'] }] } },
    { required: ['filename', 'file'], not: { required: ['templateId'] } },
  ],
  properties: {
    ...uploadFields,
    templateId: { type: 'string', enum: ['invoice', 'letter', 'brief'] },
    values: {
      type: 'object',
      maxProperties: 64,
      propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$', not: { enum: ['constructor', 'prototype'] } },
      additionalProperties: { type: 'string', maxLength: 4000 },
    },
  },
}

export function readUpload(input) {
  const buffer = Buffer.from(input, 'base64')
  if (buffer.length === 0 || buffer.length > maxFileBytes || buffer.toString('base64') !== input) {
    throw new InputError('Upload a valid file that is 4 MB or smaller.')
  }
  return buffer
}

export function sendAttachment(reply, bytes, type, filename) {
  const fallback = filename.replace(/[^a-zA-Z0-9._ -]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))
  return reply.type(type).header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`).send(bytes)
}

export async function readArtifact(response) {
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > maxOutputBytes) throw new InputError('The generated file exceeds the 16 MB output limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}
