import { useState, type FormEvent } from 'react'
import { ArrowRight, FilePenLine, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react'
import { Brand } from '../shared/Brand'
import { DocumentFlowIllustration } from '../shared/DocumentFlowIllustration'
import { authConfigured, signIn, type Identity } from './supabase-auth'
import './sign-in.css'

export function SignInPage({ loading, unavailable, onSignIn }: {
  loading: boolean
  unavailable: boolean
  onSignIn: (identity: Identity) => void
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    try {
      onSignIn(await signIn(String(form.get('email')).trim(), String(form.get('password'))))
    } catch {
      setError('Sign-in failed. Check your credentials or contact your workspace administrator.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-story"><Brand /><div><span className="hero-label"><Sparkles size={14} /> DOCUMENT WORKSPACE</span>
        <h1>From data to finished documents.</h1><p>Create Word documents and convert them to PDF in a workspace your team controls.</p>
        <DocumentFlowIllustration />
      </div></div>
      <div className="login-area">
        <section className="login-card"><span className="icon-chip violet"><ShieldCheck size={22} /></span>
          <h2>{loading ? 'Checking your session' : authConfigured ? 'Sign in to your workspace' : 'Connect Supabase Auth'}</h2>
          <p>{loading ? 'Connecting to your identity provider.' : authConfigured ? 'Use the account provided by your workspace administrator.' : 'Set the Supabase project URL and publishable key to enable workspace sign-in.'}</p>
          {unavailable && <p className="error-box" role="alert">Your session could not be verified. Sign in again to continue.</p>}
          {error && <p className="error-box" role="alert">{error}</p>}
          {loading ? <LoaderCircle className="spin" size={21} aria-label="Checking session" /> : authConfigured && <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <label className="field">Email<input type="email" name="email" autoComplete="username" required /></label>
              <label className="field">Password<input type="password" name="password" autoComplete="current-password" required /></label>
              <button className="button primary" type="submit">{busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={16} /></button>
            </fieldset>
          </form>}
          <a className="button secondary local-editor-link" href="/editor.html"><FilePenLine size={16} /> Open local DOCX editor</a>
        </section>
      </div>
    </main>
  )
}
