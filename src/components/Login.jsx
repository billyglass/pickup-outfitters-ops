import { useEffect, useState } from 'react'
import { signIn, requireActiveProfile, updatePassword, requestPasswordReset, getSession, isInviteOrRecoveryCallback, clearAuthHash } from '../lib/auth.js'
import { supabaseConfigured } from '../lib/supabase.js'

// Set-password screen: shown when a user arrives via a Supabase invite
// (type=invite) or password-reset link (type=recovery). They already have a
// session from the link, but no password yet — they must set one here
// before they can sign in normally. Minimum 8 characters.
export function SetPassword({ user, onDone, onSignOut }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await updatePassword(newPassword)
      // Re-check the profile (must exist and be active) before entering the app.
      const sessionUser = user || (await getSession())?.user
      if (!sessionUser) throw new Error('Your invite session expired. Use "Forgot password?" on the sign-in screen to get a new link.')
      const profile = await requireActiveProfile(sessionUser)
      clearAuthHash()
      onDone(sessionUser, profile)
    } catch (err) {
      setError(err.message || 'Could not set your password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <div className="logo-mark">PICKUP <span>OUTFITTERS</span></div>
        <p className="muted">Set your password to finish creating your account.</p>
        <p className="small muted">Signed in as {user?.email || 'your invited account'}. Choose a password (at least 8 characters) — you will use it to sign in from now on.</p>
        <form onSubmit={submit}>
          <label htmlFor="setpw-new">New password</label>
          <input
            id="setpw-new"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <label htmlFor="setpw-confirm">Confirm new password</label>
          <input
            id="setpw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {error && <div className="error">{error}</div>}
          <div style={{ marginTop: 16 }}>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set password & continue'}
            </button>
          </div>
        </form>
        {onSignOut && (
          <p className="small muted" style={{ marginTop: 16 }}>
            <button className="btn secondary" type="button" onClick={onSignOut}>Sign out</button>
          </p>
        )}
      </div>
    </div>
  )
}

export default function Login({ onAuthed }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Forgot-password flow
  const [showForgot, setShowForgot] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)
  const [forgotBusy, setForgotBusy] = useState(false)
  // Invite / recovery callback landing on the login screen directly
  const [inviteUser, setInviteUser] = useState(null)

  useEffect(() => {
    if (!supabaseConfigured || !isInviteOrRecoveryCallback()) return
    let cancelled = false
    getSession().then((session) => {
      if (!cancelled && session?.user) setInviteUser(session.user)
    })
    return () => { cancelled = true }
  }, [])

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

  async function submitForgot(e) {
    e.preventDefault()
    setError('')
    setForgotBusy(true)
    try {
      await requestPasswordReset(email.trim())
      setForgotSent(true)
    } catch (err) {
      setError(err.message || 'Could not send the reset email.')
    } finally {
      setForgotBusy(false)
    }
  }

  if (inviteUser) {
    return (
      <SetPassword
        user={inviteUser}
        onDone={onAuthed}
        onSignOut={() => { setInviteUser(null); clearAuthHash() }}
      />
    )
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
        {showForgot ? (
          <form onSubmit={submitForgot}>
            <p className="muted">Enter your email and we will send you a link to set a new password. The link opens this app — it works on your phone.</p>
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {error && <div className="error">{error}</div>}
            {forgotSent && <div className="success">Check your email for the reset link. It expires in about an hour — open it on your phone and set a new password there.</div>}
            <div style={{ marginTop: 16 }}>
              <button className="btn" type="submit" disabled={forgotBusy || !supabaseConfigured}>
                {forgotBusy ? 'Sending…' : 'Send reset link'}
              </button>{' '}
              <button className="btn secondary" type="button" onClick={() => { setShowForgot(false); setForgotSent(false); setError('') }}>Back to sign in</button>
            </div>
          </form>
        ) : (
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
            <p className="small" style={{ marginTop: 12 }}>
              <button
                className="btn secondary"
                type="button"
                disabled={!supabaseConfigured}
                onClick={() => { setShowForgot(true); setError('') }}
              >
                Forgot password?
              </button>
            </p>
          </form>
        )}
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
