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
  const groups = [...new Set(item.fields.flatMap((field) => {
    const match = field.match(/^([A-Za-z][A-Za-z0-9_]*)\[\]/)
    return match ? [match[1]] : []
  }))]
  const plain = item.fields.filter((field) => !field.includes('[]') && !groups.includes(field))
  const description = [...plain, ...groups.map((group) => `Repeating section: ${group}`)].join(', ')
  return { ...item, category: 'SAVED TEMPLATE', tone: 'violet', description: description || 'A Word template without runtime fields.' }
}
