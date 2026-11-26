import assert from 'node:assert/strict'
import test from 'node:test'
import { csvHeaders, defaultMapping, parseCsv, prepareBatch } from '../../frontend/src/workspace/batch-input.ts'
import { certificateRosterIssues } from '../../shared/certificate-roster.mjs'
import { starterLayouts } from '../../shared/starter-layouts.mjs'

test('header download contains only the selected fields with round-trippable CSV escaping', () => {
  const fields = ['Reference', 'Field, other', 'Field "A"', 'Multiline\nfield']
  const header = csvHeaders(fields)
  assert.equal(header, 'Reference,"Field, other","Field ""A""","Multiline\nfield"\r\n')
  assert.deepEqual(parseCsv(header + '1,2,3,4').headers, fields)
})

test('certificate rosters reject blank fields and duplicate trimmed IDs with data row numbers', () => {
  const complete = Object.fromEntries(starterLayouts.certificate.lines.map(([, field]) => [field, 'Test']))
  const rows = [' Cert-001 ', 'cert-001', 'Cert-001', '\t', 'Cert-001'].map(certificate_id => ({ values: { ...complete, certificate_id } }))
  rows[1].values.issuer_name = '  '
  const input = structuredClone(rows)
  assert.deepEqual(certificateRosterIssues(rows), [
    'Data row 2 needs a value for {issuer_name}.',
    'Data row 3 repeats the certificate ID from data row 1.',
    'Data row 4 needs a value for {certificate_id}.',
    'Data row 5 repeats the certificate ID from data row 1.',
  ])
  assert.deepEqual(rows, input)
  assert.deepEqual(certificateRosterIssues([{ values: complete }]), [])
})

test('CSV import preserves references, commas, escaped quotes, embedded CRLF and empty cells', () => {
  const result = parseCsv('\uFEFFReference,Comment,Notes\r\n000123,"first, then ""second""\r\nnext",\r\n\r\n"","",plain\r\n')
  assert.deepEqual(result, {
    headers: ['Reference', 'Comment', 'Notes'],
    rows: [['000123', 'first, then "second"\r\nnext', ''], ['', '', 'plain']],
  })
})

test('CSV reports invalid quoting and structural errors using the data row or CSV record', () => {
  assert.throws(() => parseCsv('Name,\n1,2'), /every CSV column a header/)
  assert.throws(() => parseCsv('Name, name\r\n1,2'), /different header/)
  assert.throws(() => parseCsv('A,B\n1,"two\nlines"\nonly-one'), /Data row 2 has 1 columns/)
  assert.throws(() => parseCsv('A\n"open'), /quoted field in CSV record 2/)
  assert.throws(() => parseCsv('A\n"closed"x'), /quotation marks in CSV record 2/)
  assert.throws(() => parseCsv('A\nwrong"quote'), /quotation marks in CSV record 2/)
  assert.throws(() => parseCsv('A\n'), /one data row/)
})

test('CSV record and column limits are enforced at the boundary', () => {
  const records = count => 'A\n' + Array(count).fill('0').join('\n')
  assert.equal(parseCsv(records(100)).rows.length, 100)
  assert.throws(() => parseCsv(records(101)), /100 data rows/)
  const tooWide = Array.from({ length: 257 }, (_, i) => 'c' + i).join(',')
  assert.throws(() => parseCsv(tooWide + '\n' + tooWide), /256 columns/)
})

test('mapping prefers exact headers and requires explicit choice for ambiguous normalized names', () => {
  const headers = ['Invoice Number', 'Full Name', 'full-name', 'amount_due']
  const fields = ['invoice_number', 'full_name', 'amount_due', 'other']
  assert.deepEqual(defaultMapping(fields, headers), { invoice_number: 0, full_name: -1, amount_due: 3, other: -1 })
  const sheet = { headers, rows: [['005', 'Alex', 'A.', '9.95']] }
  const result = prepareBatch(sheet, fields, defaultMapping(fields, headers), -1)
  assert.equal(result.issues.length, 2)
  assert.equal(result.rows.length, 0)
})

test('mapped data keeps exact text, validates invalid rows, and numbers missing filenames', () => {
  const fields = ['id', 'msg']
  const sheet = { headers: ['ID', 'Message', 'Filename'], rows: [
    ['0009', '  Grüße  ', ''], ['0010', '', '0010'], ['0011', '😀'.repeat(4001), 'a'.repeat(121)],
  ] }
  const result = prepareBatch(sheet, fields, { id: 0, msg: 1 }, 2)
  assert.deepEqual(result.rows[0], { name: 'Document-001', values: { id: '0009', msg: '  Grüße  ' } })
  assert.equal(result.rows[1].name, '0010')
  assert.equal(result.blankCells, 1)
  assert.deepEqual(result.issues, ['Data row 3 has a filename longer than 120 characters.', 'Data row 3, {msg} exceeds 4,000 characters.'])
  const valid = prepareBatch({ headers: ['x'], rows: [['😀'.repeat(4000)]] }, ['x'], { x: 0 }, -1)
  assert.equal(valid.issues.length, 0)
})
