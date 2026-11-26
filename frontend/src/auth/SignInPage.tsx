import { useState, type FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, FilePenLine, LoaderCircle } from 'lucide-react'
import { Brand } from '../shared/Brand'
import { authConfigured, signIn, register, type Identity } from './supabase-auth'
import './sign-in.css'

export function SignInPage({ loading, sessionError, onSignIn }: {
  loading: boolean
  sessionError?: { message: string; returnUrl: string }
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

  const title = loading ? 'Checking your session' : !authConfigured ? 'Workspace sign-in is unavailable' : creating ? 'Create an account' : 'Sign in'
  return <div className="login">
    <header className="login-masthead">
      <Brand />
      {(authConfigured || loading) && <a className="login-tool-link" href="/editor.html">Local DOCX editor <ArrowUpRight size={15} aria-hidden="true" /></a>}
    </header>
    <main className="login-area" aria-labelledby="login-title">
      <div className="login-card">
        <h1 id="login-title">{title}</h1>
        <p className="login-description">{loading ? 'Connecting to your identity provider…'
          : !authConfigured ? 'You can still open and edit Word documents on this device.'
          : creating ? 'Verify your email to create or join an organization.'
          : 'Use your verified account to open your workspace.'}</p>
        {sessionError && !error && !notice && <div className="error-box login-session-error" role="alert"><p>{sessionError.message}</p>
          <a href={sessionError.returnUrl}>Return to organizations</a></div>}
        {notice && <p role="status" className="success-box">{notice}</p>}
        {error && <p className="error-box" role="alert">{error}</p>}
        {loading ? <span className="login-loading" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true" /><span className="sr-only">Checking session</span></span>
          : authConfigured ? <>
            <form onSubmit={submit}>
              <fieldset disabled={busy}>
                <label className="field">Email address<input type="email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
                <label className="field">Password<input type="password" name="password" autoComplete={creating ? 'new-password' : 'current-password'}
                  minLength={creating ? 8 : 1} aria-describedby={creating ? 'password-help' : undefined} required /></label>
                {creating && <p id="password-help" className="login-help">Use at least 8 characters.</p>}
                <button className="button primary login-submit" type="submit">
                  {busy ? 'Please wait…' : creating ? 'Create account' : 'Sign in'}<ArrowRight size={16} aria-hidden="true" />
                </button>
              </fieldset>
            </form>
            <p className="login-switch">{creating ? 'Already have an account?' : 'New to DocuScripter?'}{' '}
              <button type="button" disabled={busy} onClick={() => { setCreating(!creating); setError(''); setNotice('') }}>
                {creating ? 'Sign in' : 'Create an account'}
              </button>
            </p>
          </> : <>
            <a className="button primary login-submit" href="/editor.html"><FilePenLine size={16} aria-hidden="true" /> Open local DOCX editor</a>
            <details className="login-setup"><summary>Administrator setup</summary><p>Set the Supabase project URL and publishable key in the deployment configuration to enable workspace sign-in.</p></details>
          </>}
      </div>
    </main>
  </div>
}
