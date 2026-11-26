export type CsvSheet = { headers: string[]; rows: string[][] }
export type BatchInput = { name: string; values: Record<string, string> }
export const maxCsvBytes = 2 * 1024 * 1024

export function csvHeaders(fields: readonly string[]) {
  return fields.map(field => /[",\r\n]/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field).join(',') + '\r\n'
}

function tooLong(text: string, max: number) {
  return text.length > max && (text.length > 2 * max || Array.from(text).length > max)
}

export function parseCsv(text: string): CsvSheet {
  const source = text.replace(/^\uFEFF/, '')
  const records: string[][] = []
  let row: string[] = [], field = '', quoted = false, closedQuote = false, touched = false

  function finishField() {
    if (row.length >= 256) throw new Error('The CSV can contain up to 256 columns.')
    row.push(field)
    field = ''
    closedQuote = false
  }
  function finishRecord() {
    if (!touched) return
    finishField()
    records.push(row)
    if (records.length > 101) throw new Error('Choose a CSV with up to 100 data rows.')
    row = []
    touched = false
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      if (ch !== '"') field += ch
      else if (source[i + 1] === '"') { field += '"'; i++ }
      else { quoted = false; closedQuote = true }
    } else if (ch === '\n' || ch === '\r') {
      finishRecord()
      if (ch === '\r' && source[i + 1] === '\n') i++
    } else {
      touched = true
      if (ch === ',') finishField()
      else if (ch === '"' && !field && !closedQuote) quoted = true
      else if (closedQuote || ch === '"') throw new Error('Check the quotation marks in CSV record ' + (records.length + 1) + '.')
      else field += ch
    }
  }
  if (quoted) throw new Error('Close the quoted field in CSV record ' + (records.length + 1) + '.')
  finishRecord()
  if (records.length < 2) throw new Error('Include a header row and at least one data row.')
  const headers = records.shift()!.map(header => header.trim())
  if (headers.some(header => !header)) throw new Error('Give every CSV column a header.')
  if (new Set(headers.map(header => header.toLowerCase())).size !== headers.length) throw new Error('Use a different header for each CSV column.')
  for (const [index, cells] of records.entries()) {
    if (cells.length !== headers.length) throw new Error('Data row ' + (index + 1) + ' has ' + cells.length + ' columns. The header has ' + headers.length + '.')
  }
  return { headers, rows: records }
}

export function defaultMapping(fields: readonly string[], headers: string[]) {
  const normalize = (label: string) => label.trim().toLowerCase().replace(/[\s_-]+/g, '_')
  return Object.fromEntries(fields.map(field => {
    const exact = headers.indexOf(field)
    if (exact !== -1) return [field, exact]
    const matches = headers.map(normalize).flatMap((name, i) => name === normalize(field) ? [i] : [])
    return [field, matches.length === 1 ? matches[0] : -1]
  }))
}

export function prepareBatch(sheet: CsvSheet, fields: readonly string[], mapping: Record<string, number>, nameColumn: number) {
  const issues: string[] = []
  let blankCells = 0
  const rows: BatchInput[] = []
  for (const field of fields) {
    if (!(mapping[field] >= 0 && mapping[field] < sheet.headers.length)) issues.push('Choose a column for {' + field + '}.')
  }
  if (issues.length) return { issues, rows, blankCells }
  for (const [index, cells] of sheet.rows.entries()) {
    const fallback = 'Document-' + String(index + 1).padStart(3, '0')
    const name = cells[nameColumn]?.trim() || fallback
    if (tooLong(name, 120)) issues.push('Data row ' + (index + 1) + ' has a filename longer than 120 characters.')
    const entries = fields.map(field => {
      const value = cells[mapping[field]]
      if (!value.trim()) blankCells++
      if (tooLong(value, 4000)) issues.push('Data row ' + (index + 1) + ', {' + field + '} exceeds 4,000 characters.')
      return [field, value]
    })
    rows.push({ name, values: Object.fromEntries(entries) })
  }
  return { rows, issues, blankCells }
}
