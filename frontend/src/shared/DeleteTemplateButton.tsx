import { Trash2 } from 'lucide-react'

export function DeleteTemplateButton({ name, organization, disabled, onDelete }: {
  name: string
  organization: string
  disabled: boolean
  onDelete: () => void
}) {
  const label = 'Delete template ' + name
  return <button type="button" className="icon-button template-delete" aria-label={label} title={label} disabled={disabled}
    onClick={() => {
      if (window.confirm('Delete “' + name + '” from ' + organization + '? This removes the template and all its versions for every member of this organization.')) onDelete()
    }}><Trash2 size={16} aria-hidden="true" /></button>
}
