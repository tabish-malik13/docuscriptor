import Docxtemplater from 'docxtemplater'
import inspectModule from 'docxtemplater/js/inspect-module.js'
import PizZip from 'pizzip'
import { InputError } from '../shared/http-service.mjs'

export function inspectTemplate(source) {
  try {
    const inspector = inspectModule()
    const document = new Docxtemplater(new PizZip(source), {
      modules: [inspector], linebreaks: true, errorLogging: false,
    })
    const tags = inspector.getAllStructuredTags()
    if (tags.length > 1024) throw new InputError('The template exceeds the 1,024 placeholder limit.')
    for (const tag of tags) {
      if (tag.module || typeof tag.value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tag.value) || ['constructor', 'prototype'].includes(tag.value)) {
        throw new InputError('Use simple text fields such as {customer_name} in this workflow.')
      }
    }
    const fields = [...new Set(tags.map((tag) => tag.value))]
    if (fields.length > 64) throw new InputError('Use at most 64 unique fields in a template.')
    return { document, tags, fields }
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('Check that the template has valid Word content and balanced placeholders.')
  }
}
