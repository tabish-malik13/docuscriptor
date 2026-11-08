export type Template = {
  id: string
  name: string
  category: string
  tone: string
  description: string
  fields: readonly string[]
  saved?: boolean
  createdBy?: string
}

export type SavedTemplate = { id: string; name: string; fields: string[]; saved: true; createdBy: string }

export const templates: Template[] = [
  { id: 'invoice', name: 'Invoice', category: 'FINANCE', tone: 'violet', description: 'Create a clean invoice with billing details, a description, and an amount due.', fields: ['invoice_number', 'customer_name', 'description', 'amount_due'] },
  { id: 'letter', name: 'Business letter', category: 'CORRESPONDENCE', tone: 'mint', description: 'Send formal correspondence with a consistent, professional layout.', fields: ['recipient_name', 'date', 'subject', 'body', 'sender_name'] },
  { id: 'brief', name: 'Project brief', category: 'OPERATIONS', tone: 'amber', description: 'Document the objective, deliverables, and owner for a new project.', fields: ['project_name', 'owner', 'objective', 'deliverables'] },
]

export function savedTemplate(item: SavedTemplate): Template {
  return { ...item, category: 'SAVED TEMPLATE', tone: 'violet', description: item.fields.length ? item.fields.join(', ') : 'A Word template without runtime fields.' }
}
