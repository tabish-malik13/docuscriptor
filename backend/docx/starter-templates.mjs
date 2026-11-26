import { AlignmentType, BorderStyle, Document, Packer, PageOrientation, Paragraph, TextRun } from 'docx'

import { starterLayouts } from '../../shared/starter-layouts.mjs'

function certificateSection() {
  const line = (text, size, after, options = {}) => new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after },
    children: [new TextRun({ text, size, font: 'Liberation Sans', color: '254B45', ...options })],
  })
  return {
    properties: { page: {
      size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
      margin: { top: 1900, bottom: 1100, left: 2160, right: 2160 },
    } },
    children: [
      line('{issuer_name}', 28, 320, { bold: true }),
      new Paragraph({ border: { bottom: { color: '548177', style: BorderStyle.SINGLE, size: 10 } }, spacing: { after: 920 } }),
      line(starterLayouts.certificate.title, 54, 640, { font: 'Liberation Serif', color: '183C36' }),
      line('Awarded to', 23, 160),
      line('{recipient_name}', 46, 460, { font: 'Liberation Serif', bold: true, color: '183C36' }),
      line('for completing', 23, 180),
      line('{course_name}', 34, 660, { font: 'Liberation Serif' }),
      line('Completed on {completion_date}', 24, 800),
      line('Certificate ID  ·  {certificate_id}', 21, 0),
    ],
  }
}

export function starterTemplate(id) {
  if (id === 'certificate') return Packer.toBuffer(new Document({ sections: [certificateSection()] }))
  const { title, lines } = starterLayouts[id]
  const children = [
    new Paragraph({ spacing: { after: 430 }, children: [new TextRun({ text: title, size: 40, bold: true, color: '4733A8' })] }),
    ...lines.map(([label, field]) => new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: label && label + ': ', bold: true }), new TextRun({ text: '{' + field + '}' })],
    })),
  ]
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}
