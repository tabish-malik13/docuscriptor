import { FileText } from 'lucide-react'
import type { Template } from './starter-templates'
import './document-ui.css'

export function TemplatePreview({ template }: { template: Template }) {
  return <div className={'template-sheet preview-' + (template.saved ? 'saved' : template.id)} aria-hidden="true">
    {template.saved ? <span className="saved-preview-file"><FileText size={33} strokeWidth={1.2} /><small>DOCX</small></span>
      : <img src={'/template-previews/' + template.id + '.webp'} alt="" loading="lazy" />}
  </div>
}
