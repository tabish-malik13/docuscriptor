import { uuidPattern } from '../gateway/tenant-authority.mjs'
import { starterLayouts } from '../../shared/starter-layouts.mjs'

const starterIds = Object.keys(starterLayouts)

const help = [
  'Attach a DOCX with caption pdf, generate {"field":"value"}, or save NAME. A DOCX with no caption converts to PDF.',
  'Convert a short HTML source: html <h1>Title</h1>',
  'Generate from a template: generate ' + starterIds.join('|') + '|TEMPLATE_ID {"field":"value"}',
  'Browse: jobs [page], job ID, templates [page], fields TEMPLATE_ID',
  'Download: download ID, template ID',
  'Delete: delete job ID',
].join('\n')
export class CommandError extends Error {}
export const textReply = (text) => ({ text })
const validId = (id) => typeof id === 'string' && uuidPattern.test(id)
function values(json) {
  let result
  try { result = JSON.parse(json) } catch { /* show the command syntax */ }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.values(result).some((v) => typeof v !== 'string')) {
    throw new CommandError('Enter template values as a JSON object with text values.')
  }
  return result
}

// Only these fixed paths can be reached from a message. Tenant, recipient and credentials come from the binding.
export function commandFor({ text, media }, templateDeletion = true) {
  const command = text.trim()
  if (media) {
    if (command === '' || /^pdf$/i.test(command)) return {
      method: 'POST', path: '/api/pdf/convert', payload: {}, upload: true, result: 'generated', scope: 'documents:convert',
    }
    const save = /^save\s+(.{1,120})$/is.exec(command)
    if (save) return { method: 'POST', path: '/api/templates', payload: { name: save[1] }, upload: true, result: 'saved', scope: 'templates:write' }
    const gen = /^generate\s+(.+)$/is.exec(command)
    if (gen) return { method: 'POST', path: '/api/docx/generate', payload: { values: values(gen[1]) }, upload: true, result: 'generated', scope: 'documents:generate' }
    throw new CommandError('Use the caption pdf, generate {"field":"value"}, or save NAME.')
  }
  const html = /^html\s+(.+)$/is.exec(command)
  if (html) return { method: 'POST', path: '/api/pdf/convert',
    payload: { filename: 'document.html', file: Buffer.from(html[1], 'utf8').toString('base64') }, result: 'generated', scope: 'documents:convert' }
  const gen = /^generate\s+(\S+)\s+(.+)$/is.exec(command)
  if (gen) {
    const template = gen[1].toLowerCase()
    const starter = Object.hasOwn(starterLayouts, template)
    if (!starter && !validId(template)) throw new CommandError('Choose a starter (' + starterIds.join(', ') + ') or a saved template ID.')
    return { method: 'POST', path: '/api/docx/generate', payload: { [starter ? 'templateId' : 'savedTemplateId']: template, values: values(gen[2]) },
      result: 'generated', scope: 'documents:generate' + (starter ? '' : ' templates:read') }
  }
  const list = /^(jobs|templates)(?:\s+([1-9]\d{0,2}))?$/i.exec(command)
  if (list) {
    const jobs = list[1].toLowerCase() === 'jobs', page = Number(list[2] || 1)
    const start = 10 * (page - 1)
    return { path: jobs ? '/api/jobs?offset=' + start : '/api/templates', result: jobs ? 'jobs' : 'templates', start, page, scope: jobs ? 'documents:read' : 'templates:read' }
  }
  const [verb, noun, id, extra] = command.toLowerCase().split(/\s+/)
  if (verb === 'fields' && Object.hasOwn(starterLayouts, noun) && !id) return textReply(starterLayouts[noun].lines.map(([, field]) => field).join(', '))
  if (validId(noun) && !id) {
    if (verb === 'fields') return { path: '/api/templates', result: 'fields', id: noun, scope: 'templates:read' }
    if (verb === 'job') return { path: '/api/jobs/' + noun, result: 'job', scope: 'documents:read' }
    if (verb === 'download' || verb === 'template') return downloadCommand(verb === 'download' ? 'jobs' : 'templates', noun)
  }
  if (verb === 'delete' && ['job', 'template'].includes(noun) && validId(id) && !extra) {
    const jobs = noun === 'job'
    if (!jobs && !templateDeletion) return textReply('Template deletion is disabled on this deployment.')
    return { method: 'DELETE', path: '/api/' + (jobs ? 'jobs' : 'templates') + '/' + id, result: 'deleted', scope: jobs ? 'documents:delete' : 'templates:delete' }
  }
  return textReply(templateDeletion ? help + ', delete template ID' : help)
}

export function downloadCommand(collection, id) {
  if (!validId(id)) throw new Error('Invalid artifact identifier')
  return { path: '/api/' + collection + '/' + id + '/download', result: 'file', scope: collection === 'jobs' ? 'documents:read' : 'templates:read' }
}

export function present(command, response) {
  switch (command.result) {
    case 'generated': return downloadCommand('jobs', response.headers['x-document-id'])
    case 'saved': return textReply('Saved template ' + response.json().id)
    case 'deleted': return textReply('Deleted.')
    case 'job': {
      const job = response.json()
      return textReply([job.name, job.id, job.status, job.error].filter(Boolean).join('\n'))
    }
    case 'fields': {
      const template = response.json().items.find((item) => item.id === command.id)
      return textReply(template ? (template.fields.join(', ') || 'This template has no fields.') : 'Template not found.')
    }
    case 'jobs':
    case 'templates': {
      const jobs = command.result === 'jobs', start = jobs ? 0 : command.start
      const items = response.json().items, page = items.slice(start, start + 10)
      const lines = page.map((item) => [item.id, item.name.slice(0, 100), item.status].filter(Boolean).join('  '))
      if (!jobs && command.page === 1) lines.unshift('Starter templates: ' + starterIds.join(', '))
      if (!lines.length) lines.push('No more ' + command.result + '.')
      if (items.length > start + 10) lines.push('More: ' + command.result + ' ' + (command.page + 1))
      return textReply(lines.join('\n'))
    }
    case 'file': {
      const disposition = response.headers['content-disposition'] || ''
      const filename = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      if (!filename) throw new Error('Missing download filename')
      return { bytes: response.rawPayload, filename: decodeURIComponent(filename), type: response.headers['content-type'] }
    }
    default: throw new Error('Unknown command result')
  }
}
