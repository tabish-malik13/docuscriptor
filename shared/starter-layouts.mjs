export const starterLayouts = {
  invoice: {
    name: 'Invoice',
    title: 'INVOICE',
    lines: [['Invoice number', 'invoice_number'], ['Bill to', 'customer_name'], ['Description', 'description'], ['Amount due', 'amount_due']],
  },
  letter: {
    name: 'Business letter',
    title: 'BUSINESS LETTER',
    lines: [['Date', 'date'], ['To', 'recipient_name'], ['Subject', 'subject'], ['', 'body'], ['Sincerely', 'sender_name']],
  },
  brief: {
    name: 'Project brief',
    title: 'PROJECT BRIEF',
    lines: [['Project', 'project_name'], ['Owner', 'owner'], ['Objective', 'objective'], ['Deliverables', 'deliverables']],
  },
  certificate: {
    name: 'Certificate of completion',
    title: 'Certificate of completion',
    lines: [['Recipient', 'recipient_name'], ['Course', 'course_name'], ['Completion date', 'completion_date'], ['Issued by', 'issuer_name'], ['Certificate ID', 'certificate_id']],
  },
}
