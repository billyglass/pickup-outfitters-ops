import { useState } from 'react'
import { signIn, requireActiveProfile } from '../lib/auth.js'
import { supabaseConfigured } from '../lib/supabase.js'

export default function Login({ onAuthed }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { user } = await signIn(email.trim(), password)
      const profile = await requireActiveProfile(user)
      onAuthed(user, profile)
    } catch (err) {
      setError(err.message || 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <div className="logo-mark">PICKUP <span>OUTFITTERS</span></div>
        <p className="muted">Shop Operations — sign in with your company account.</p>
        {!supabaseConfigured && (
          <div className="warn">
            Supabase is not connected yet. Add <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> (see README.md).
            Until then, sign-in is disabled.
          </div>
        )}
        <form onSubmit={submit}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <div className="error">{error}</div>}
          <div style={{ marginTop: 16 }}>
            <button className="btn" type="submit" disabled={busy || !supabaseConfigured}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
        <p className="small muted" style={{ marginTop: 16 }}>
          No public signup. An Admin creates each account — see README.md.
          Admins: enroll MFA (TOTP) in Settings after signing in.
        </p>
        {!supabaseConfigured && (
          <button
            className="btn secondary"
            type="button"
            onClick={() => onAuthed(null, { id: 'local-demo', name: 'Demo Admin', email: 'demo@local', role: 'admin', active: true, mfa_enrolled: false })}
          >
            Continue in local demo (no Supabase)
          </button>
        )}
      </div>
    </div>
  )
}
