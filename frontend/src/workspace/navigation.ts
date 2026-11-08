import { Clock3, FileOutput, FilePlus2, LayoutDashboard, LayoutTemplate, ShieldCheck } from 'lucide-react'

export const views = {
  overview: { title: 'Overview', icon: LayoutDashboard },
  generate: { title: 'Generate DOCX', icon: FilePlus2 },
  convert: { title: 'Convert to PDF', icon: FileOutput },
  templates: { title: 'Templates', icon: LayoutTemplate },
  activity: { title: 'Activity', icon: Clock3 },
  team: { title: 'Organization settings', icon: ShieldCheck },
  account: { title: 'Account & access', icon: ShieldCheck },
}
export type View = keyof typeof views

export const actions = [
  { view: 'generate', title: 'Generate DOCX', text: 'Fill a Word template with your data.', tone: 'violet', icon: FilePlus2 },
  { view: 'convert', title: 'Convert to PDF', text: 'Export Word or HTML as a PDF.', tone: 'mint', icon: FileOutput },
  { view: 'templates', title: 'Browse templates', text: 'Get started with ready-to-use layouts.', tone: 'amber', icon: LayoutTemplate },
] as const

export function readView(): View {
  const view = window.location.hash.slice(1)
  return Object.hasOwn(views, view) ? view as View : 'overview'
}
