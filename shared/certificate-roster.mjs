import { starterLayouts } from './starter-layouts.mjs'

const fields = starterLayouts.certificate.lines.map(([, field]) => field)

export function certificateRosterIssues(rows) {
  const issues = []
  const firstRowById = new Map()
  for (const [index, { values }] of rows.entries()) {
    const position = index + 1
    for (const field of fields) {
      if (!values[field]?.trim()) issues.push('Data row ' + position + ' needs a value for {' + field + '}.')
    }
    const id = values.certificate_id?.trim()
    if (!id) continue
    const first = firstRowById.get(id)
    if (first === undefined) firstRowById.set(id, position)
    else issues.push('Data row ' + position + ' repeats the certificate ID from data row ' + first + '.')
  }
  return issues
}
