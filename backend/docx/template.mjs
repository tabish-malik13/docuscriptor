import Docxtemplater from 'docxtemplater'
import inspectModule from 'docxtemplater/js/inspect-module.js'
import PizZip from 'pizzip'
import { InputError } from '../shared/http-service.mjs'
import { maxOutputBytes } from '../shared/document-http.mjs'

const fieldPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

function isDoubleBraceTemplate(zip) {
  return Object.entries(zip.files).some(([name, file]) =>
    name.startsWith('word/') && name.endsWith('.xml') && !file.dir &&
    file.asText().includes('{{') && file.asText().includes('}}'))
}

function countTags(tags) {
  return tags.reduce((total, tag) => total + 1 + (Array.isArray(tag.subparsed) ? countTags(tag.subparsed) : 0), 0)
}

function docxtemplaterOptions(inspector, doubleBrace) {
  return {
    ...(inspector ? { modules: [inspector] } : {}),
    ...(doubleBrace ? { delimiters: { start: '{{', end: '}}' } } : {}),
    parser: (rawTag) => {
      const key = rawTag.trim().replace(/\s+/g, '')
      return {
        get(scope) {
          return scope && typeof scope === 'object' && Object.hasOwn(scope, key) ? scope[key] : undefined
        },
      }
    },
    linebreaks: true,
    paragraphLoop: true,
    errorLogging: false,
  }
}

function collectFieldPaths(tags, prefix = '', output = []) {
  for (const tag of tags) {
    if (tag.module && tag.module !== 'loop') throw new InputError('This template uses a feature that is not supported yet.')
    const value = typeof tag.value === 'string' ? tag.value.trim() : ''
    if (!fieldPattern.test(value) || ['constructor', 'prototype'].includes(value)) {
      throw new InputError('Use template fields made from letters, numbers, and underscores.')
    }
    if (tag.module === 'loop') {
      const path = prefix ? `${prefix}.${value}` : value
      output.push(path)
      if (!Array.isArray(tag.subparsed)) throw new InputError('The repeating section is invalid.')
      collectFieldPaths(tag.subparsed, `${path}[]`, output)
    } else {
      output.push(prefix ? `${prefix}.${value}` : value)
    }
  }
  return output
}

export function inspectTemplate(source) {
  try {
    const zip = new PizZip(source)
    const doubleBrace = isDoubleBraceTemplate(zip)
    const inspector = inspectModule()
    const document = new Docxtemplater(zip, docxtemplaterOptions(inspector, doubleBrace))
    const tags = inspector.getAllStructuredTags()
    if (countTags(tags) > 1024) throw new InputError('The template exceeds the 1,024 placeholder limit.')
    const fields = [...new Set(collectFieldPaths(tags))]
    if (fields.length > 64) throw new InputError('Use at most 64 unique fields in a template.')
    return { document, tags, fields }
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('Check that the template has valid Word content and balanced placeholders.')
  }
}

export function validateTemplateData(tags, values) {
  let estimatedBytes = 0
  function visit(list, scope) {
    for (const tag of list) {
      if (tag.module === 'loop') {
        const rows = scope[tag.value]
        if (!Array.isArray(rows)) throw new InputError(`Provide an array for {${tag.value}}.`)
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new InputError(`Each item in {${tag.value}} must be an object.`)
          }
          visit(tag.subparsed || [], row)
        }
      } else {
        const value = scope[tag.value]
        if (!Object.hasOwn(scope, tag.value)) throw new InputError(`Provide a value for {${tag.value}}.`)
        if (value !== null && typeof value === 'object') {
          throw new InputError(`Use a scalar value for {${tag.value}} or place it inside a repeating section.`)
        }
        estimatedBytes += Buffer.byteLength(value == null ? '' : String(value)) * 6
        if (estimatedBytes > maxOutputBytes) throw new InputError('The expanded template exceeds the output limit.')
      }
    }
  }
  visit(tags, values)
}

export function createTemplate(source) {
  const zip = new PizZip(source)
  return new Docxtemplater(zip, docxtemplaterOptions(null, isDoubleBraceTemplate(zip)))
}
