export const templates = [
  { id: 'invoice', name: 'Invoice', category: 'FINANCE', tone: 'violet', description: 'Create a clean invoice with billing details, a description, and an amount due.', fields: ['invoice_number', 'customer_name', 'description', 'amount_due'] },
  { id: 'letter', name: 'Business letter', category: 'CORRESPONDENCE', tone: 'mint', description: 'Send formal correspondence with a consistent, professional layout.', fields: ['recipient_name', 'date', 'subject', 'body', 'sender_name'] },
  { id: 'brief', name: 'Project brief', category: 'OPERATIONS', tone: 'amber', description: 'Document the objective, deliverables, and owner for a new project.', fields: ['project_name', 'owner', 'objective', 'deliverables'] },
] as const

export type Template = typeof templates[number]
