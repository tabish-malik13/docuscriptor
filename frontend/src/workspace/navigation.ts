import { Clock3, CreditCard, Files, FileOutput, FilePlus2, LayoutDashboard, LayoutTemplate, ShieldCheck } from 'lucide-react'

export const views = {
  overview: { title: 'Overview', icon: LayoutDashboard },
  generate: { title: 'Generate DOCX', icon: FilePlus2 },
  batches: { title: 'Bulk generation', icon: Files },
  convert: { title: 'Convert to PDF', icon: FileOutput },
  templates: { title: 'Templates', icon: LayoutTemplate },
  activity: { title: 'Activity', icon: Clock3 },
  team: { title: 'Organization settings', icon: ShieldCheck },
  billing: { title: 'Billing & plans', icon: CreditCard },
  account: { title: 'Account & access', icon: ShieldCheck },
}
export type View = keyof typeof views

export const actions = [
  { view: 'generate', title: 'Generate DOCX', text: 'Fill a Word template', icon: FilePlus2 },
  { view: 'convert', title: 'Convert to PDF', text: 'From Word or HTML', icon: FileOutput },
  { view: 'batches', title: 'Bulk generation', text: 'From a spreadsheet', icon: Files },
  { view: 'templates', title: 'Browse templates', text: 'Get started with ready-to-use layouts.', icon: LayoutTemplate },
] as const

export function readView(): View {
  const view = window.location.hash.slice(1)
  return Object.hasOwn(views, view) ? view as View : 'overview'
}
