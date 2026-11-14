import { supabase, supabaseConfigured } from './supabase.js'

// Auth: Supabase Auth, email + password only. No public signup — an Admin
// creates the Auth user (Supabase Dashboard -> Authentication -> Add user),
// then inserts the matching profiles row. See README.md.
// Admin MFA is TOTP via Supabase Auth (enroll / verify below). Admins must
// enroll before daily use; the app shows a reminder until mfa_enrolled.

export async function getSession() {
  if (!supabaseConfigured) return null
  const { data } = await supabase.auth.getSession()
  return data.session ?? null
}

export async function getProfile(userId) {
  if (!supabaseConfigured || !userId) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error) return null
  return data
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}

// Throws if the profile is missing or deactivated. RLS also blocks data
// for deactivated users, so this is a second, user-visible check.
export async function requireActiveProfile(user) {
  const profile = await getProfile(user.id)
  if (!profile) {
    throw new Error(
      'No profile found for this login. An Admin must create a profiles row for this user (see README.md).'
    )
  }
  if (!profile.active) {
    await supabase.auth.signOut()
    throw new Error('This account has been deactivated. Contact an Admin.')
  }
  return profile
}

// --- Admin MFA (TOTP) -------------------------------------------------------
// Enroll returns { factorId, qrCode, secret } — show qrCode to the Admin,
// have them scan it in an authenticator app, then call verifyMfaEnroll.
export async function enrollMfa() {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Pickup Outfitters Admin',
  })
  if (error) throw error
  return data // data.totp.qr_code (SVG), data.totp.secret, data.id
}

export async function verifyMfaEnroll(factorId, code) {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code,
  })
  if (error) throw error
  return data
}

export async function verifyMfa(factorId, code) {
  const { data, error } = await supabase.auth.mfa.verify({
    factorId,
    code,
  })
  if (error) throw error
  return data
}

export async function listMfaFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw error
  return data
}
