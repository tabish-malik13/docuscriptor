export type Activity = {
  id: string
  name: string
  kind: 'DOCX' | 'PDF'
  source: string
  when: string
  artifact?: Blob
}
