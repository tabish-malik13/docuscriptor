import { useId } from 'react'
import { FileCheck2, Upload } from 'lucide-react'
import './document-ui.css'

export function FilePicker({ label, hint, accept, filename, onChange, name, required }: {
  label: string
  hint: string
  accept: string
  filename: string
  onChange: (file?: File) => void
  name?: string
  required?: boolean
}) {
  const id = useId()
  const Icon = filename ? FileCheck2 : Upload
  return <label className={'file-picker' + (filename ? ' has-file' : '')}>
    <span className="file-picker-icon" aria-hidden="true"><Icon size={21} strokeWidth={1.6} /></span>
    <span className="file-picker-info"><strong>{filename || label}</strong><small id={id}>{hint}</small></span>
    <span className="file-picker-browse" aria-hidden="true">{filename ? 'Change file' : 'Choose file'}</span>
    <input type="file" name={name} required={required} aria-label={label} aria-describedby={id} accept={accept}
      onChange={event => onChange(event.target.files?.[0])} />
  </label>
}
