import { ArrowDown, ArrowRight, ArrowUpRight, Download, FileText, LockKeyhole, ListChecks } from 'lucide-react'
import { Brand } from '../shared/Brand'
import { directoryUrl } from './organization-location'
import './landing.css'

const steps = [
  {
    icon: FileText,
    title: 'Start with your Word design',
    description: 'Use a Word template with placeholders such as {recipient_name} and {course_name}.',
  },
  {
    icon: ListChecks,
    title: 'Fill in the certificate fields',
    description: 'Enter the learner, course, issuer, completion date, and certificate ID in your workspace.',
  },
  {
    icon: Download,
    title: 'Download the certificate',
    description: 'Download the editable Word file or convert it to PDF in your workspace.',
  },
]

export function LandingPage() {
  return <div className="landing">
    <a className="skip-link" href="#product">Skip to content</a>
    <div className="landing-dark">
      <header className="landing-wrap landing-header">
        <a className="landing-brand" href="/"><Brand /></a>
        <nav className="landing-nav" aria-label="Product">
          <a className="landing-nav-workflow" href="#workflow">How it works</a>
          <a href="/editor.html">Word editor <ArrowUpRight size={15} aria-hidden="true" /></a>
          <a className="landing-nav-workspace" href={directoryUrl}>Workspace <ArrowRight size={15} aria-hidden="true" /></a>
        </nav>
      </header>
      <main id="product" tabIndex={-1}>
        <section className="landing-wrap landing-hero" aria-labelledby="landing-title">
          <div className="landing-intro">
            <p className="landing-kicker">For training teams</p>
            <h1 id="landing-title">Create <span>completion certificates.</span></h1>
            <p className="landing-lede">Use your Word template to generate an editable Word certificate or convert the document to PDF.</p>
            <div className="landing-actions">
              <a className="landing-cta" href={directoryUrl}>Open workspace <ArrowRight size={18} aria-hidden="true" /></a>
              <a className="landing-workflow-link" href="#workflow">See how it works <ArrowDown size={16} aria-hidden="true" /></a>
            </div>
          </div>
          <figure className="landing-figure">
            <figcaption><FileText size={16} aria-hidden="true" /> Certificate template preview</figcaption>
            <div className="landing-paper">
              <img src="/template-previews/certificate.webp" width="720" height="557"
                alt="Completion certificate template with placeholders for the recipient, course, issuer, completion date and certificate ID" />
            </div>
            <div className="landing-files" aria-label="Certificate input and output">
              <span><ListChecks size={19} aria-hidden="true" /> Certificate fields</span>
              <ArrowRight size={17} aria-hidden="true" />
              <span><Download size={19} aria-hidden="true" /> Word or PDF</span>
            </div>
          </figure>
        </section>
        <div className="landing-light">
          <section className="landing-wrap landing-workflow" id="workflow" aria-labelledby="workflow-title">
            <div className="landing-section-heading">
              <div>
                <p className="landing-kicker">How it works</p>
                <h2 id="workflow-title">From template to certificate</h2>
              </div>
              <p>Save templates and generated files in your organization workspace.</p>
            </div>
            <ol className="landing-steps">
              {steps.map(({ icon: Icon, title, description }) =>
                <li key={title}>
                  <Icon size={23} aria-hidden="true" />
                  <h3>{title}</h3>
                  <p>{description}</p>
                </li>
              )}
            </ol>
          </section>
          <section className="landing-wrap landing-hosting" aria-labelledby="hosting-title">
            <div className="landing-hosting-icon"><LockKeyhole size={24} aria-hidden="true" /></div>
            <div>
              <h2 id="hosting-title">Run it on your infrastructure</h2>
              <p>Self-host DocuScripter and give verified team members access to shared templates and generated files in your organization workspace.</p>
            </div>
            <a className="landing-cta" href={directoryUrl}>Open workspace <ArrowRight size={18} aria-hidden="true" /></a>
          </section>
        </div>
      </main>
    </div>
    <footer className="landing-wrap landing-footer">
      <a className="landing-brand" href="/"><Brand /></a>
      <a href="/editor.html">Open the local Word editor <ArrowUpRight size={15} aria-hidden="true" /></a>
    </footer>
  </div>
}
