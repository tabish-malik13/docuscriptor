import { Document, Packer, Paragraph, TextRun } from 'docx'

const layouts = {
  invoice: {
    title: 'INVOICE',
    lines: [['Invoice number', 'invoice_number'], ['Bill to', 'customer_name'], ['Description', 'description'], ['Amount due', 'amount_due']],
  },
  letter: {
    title: 'BUSINESS LETTER',
    lines: [['Date', 'date'], ['To', 'recipient_name'], ['Subject', 'subject'], ['', 'body'], ['Sincerely', 'sender_name']],
  },
  brief: {
    title: 'PROJECT BRIEF',
    lines: [['Project', 'project_name'], ['Owner', 'owner'], ['Objective', 'objective'], ['Deliverables', 'deliverables']],
  },
}

export function starterTemplate(id) {
  const { title, lines } = layouts[id]
  const children = [
    new Paragraph({ spacing: { after: 430 }, children: [new TextRun({ text: title, size: 40, bold: true, color: '4733A8' })] }),
    ...lines.map(([label, field]) => new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: label && label + ': ', bold: true }), new TextRun({ text: '{' + field + '}' })],
    })),
  ]
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}
