export type Template = {
  id: string
  name: string
  category: string
  description: string
  fields: readonly string[]
  saved?: boolean
  version?: number
  createdBy?: string
}

export type SavedTemplate = { id: string; name: string; fields: string[]; saved: true; createdBy: string; version: number }

export const templates: Template[] = [
  { id: 'certificate', name: 'Certificate of completion', category: 'TRAINING', description: 'Issue a named certificate with a course, completion date, issuer, and certificate ID.', fields: ['recipient_name', 'course_name', 'completion_date', 'issuer_name', 'certificate_id'] },
  { id: 'invoice', name: 'Invoice', category: 'FINANCE', description: 'Create a clean invoice with billing details, a description, and an amount due.', fields: ['invoice_number', 'customer_name', 'description', 'amount_due'] },
  { id: 'letter', name: 'Business letter', category: 'CORRESPONDENCE', description: 'Send formal correspondence with a consistent, professional layout.', fields: ['recipient_name', 'date', 'subject', 'body', 'sender_name'] },
  { id: 'brief', name: 'Project brief', category: 'OPERATIONS', description: 'Document the objective, deliverables, and owner for a new project.', fields: ['project_name', 'owner', 'objective', 'deliverables'] },
]

export function savedTemplate(item: SavedTemplate): Template {
  return { ...item, category: 'SAVED TEMPLATE', description: item.fields.length ? item.fields.join(', ') : 'A Word template without runtime fields.' }
}
