export type Activity = {
  id: string
  createdBy: string
  name: string
  kind: 'DOCX' | 'PDF'
  source: string
  when: string
  status: 'processing' | 'ready' | 'failed'
  error?: string | null
}
