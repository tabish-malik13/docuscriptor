import { processingEnabled } from '../workspace/features'
import { useState, type FormEvent } from 'react'
import { ArrowRight, FilePenLine, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react'
import { Brand } from '../shared/Brand'
import { DocumentFlowIllustration } from '../shared/DocumentFlowIllustration'
import { authConfigured, signIn, register, type Identity } from './supabase-auth'
import './sign-in.css'

export function SignInPage({ loading, unavailable, onSignIn }: {
  loading: boolean
  unavailable: boolean
  onSignIn: (identity: Identity) => void
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    setError(''); setNotice('')
    setBusy(true)
    try {
      const email = String(form.get('email')).trim(), password = String(form.get('password'))
      if (creating) {
        await register(email, password)
        setNotice('Check your email to verify your account, then return here and sign in.')
        setCreating(false)
      } else onSignIn(await signIn(email, password))
    } catch {
      setError(creating ? 'Account creation failed. Check your details or contact your administrator.' : 'Sign-in failed. Verify your email and check your credentials.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-story"><Brand /><div><span className="hero-label"><Sparkles size={14} /> DOCUMENT WORKSPACE</span>
        <h1>From data to finished documents.</h1><p>{processingEnabled ? 'Create Word documents and convert them to PDF in a workspace your team controls.' : 'Edit Word documents and store files in a private workspace for your team.'}</p>
        <DocumentFlowIllustration />
      </div></div>
      <div className="login-area">
        <section className="login-card"><span className="icon-chip violet"><ShieldCheck size={22} /></span>
          <h2>{loading ? 'Checking your session' : authConfigured ? creating ? 'Create your account' : 'Sign in to your workspace' : 'Connect Supabase Auth'}</h2>
          <p>{loading ? 'Connecting to your identity provider.' : authConfigured ? 'Sign in with a verified account to create an organization or accept an invitation.' : 'Set the Supabase project URL and publishable key to enable workspace sign-in.'}</p>
          {unavailable && <p className="error-box" role="alert">Your session could not be verified. Sign in again to continue.</p>}
          {notice && <p role="status" className="success-box">{notice}</p>}
          {error && <p className="error-box" role="alert">{error}</p>}
          {loading ? <LoaderCircle className="spin" size={21} aria-label="Checking session" /> : authConfigured && <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <label className="field">Email<input type="email" name="email" autoComplete="username" required /></label>
              <label className="field">Password<input type="password" name="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? 8 : 1} required /></label>
              <button className="button primary" type="submit">{busy ? 'Please wait…' : creating ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
            </fieldset>
          </form>}
          {authConfigured && !loading && <button className="button secondary local-editor-link" disabled={busy} onClick={() => { setCreating(!creating); setError(''); setNotice('') }}>{creating ? 'Already have an account? Sign in' : 'Create an account'}</button>}
          <a className="button secondary local-editor-link" href="/editor.html"><FilePenLine size={16} /> Open local DOCX editor</a>
        </section>
      </div>
    </main>
  )
}
