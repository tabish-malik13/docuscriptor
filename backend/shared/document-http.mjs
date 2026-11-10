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
  $defs: {
    runtimeValue: {
      anyOf: [
        { type: 'string', maxLength: 4000 },
        { type: 'array', maxItems: 200, items: { $ref: '#/$defs/runtimeValue' } },
        {
          type: 'object', maxProperties: 64,
          propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$', not: { enum: ['constructor', 'prototype'] } },
          additionalProperties: { $ref: '#/$defs/runtimeValue' },
        },
      ],
    },
  },
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
      additionalProperties: { $ref: '#/$defs/runtimeValue' },
    },
  },
}

const fieldNamePattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

// Runtime data can contain bounded arrays/objects for repeating DOCX sections.
// Keep the shape small enough to validate and render predictably in both services.
export function validateRuntimeValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new InputError('Runtime values must be a JSON object.')
  }
  let nodes = 0
  let arrayItems = 0
  let textBytes = 0
  function visit(value, depth) {
    if (++nodes > 2048) throw new InputError('Runtime values contain too many entries.')
    if (depth > 8) throw new InputError('Runtime values are nested too deeply.')
    if (typeof value === 'string') {
      textBytes += Buffer.byteLength(value)
      if (value.length > 4000 || textBytes > 1024 * 1024) throw new InputError('Runtime text exceeds the supported size.')
      return
    }
    if (Array.isArray(value)) {
      arrayItems += value.length
      if (value.length > 200 || arrayItems > 200) throw new InputError('Runtime arrays may contain at most 200 items in total.')
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const entries = Object.entries(value)
      if (entries.length > 64) throw new InputError('Runtime objects may contain at most 64 fields.')
      for (const [key, item] of entries) {
        if (!fieldNamePattern.test(key) || key === 'constructor' || key === 'prototype') {
          throw new InputError('Runtime field names must use letters, numbers, and underscores.')
        }
        visit(item, depth + 1)
      }
      return
    }
    throw new InputError('Runtime values must contain text, arrays, and objects.')
  }
  if (Object.getPrototypeOf(values) !== Object.prototype || Object.keys(values).length > 64) {
    throw new InputError('Runtime values must be a JSON object with at most 64 fields.')
  }
  visit(values, 0)
  return values
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
