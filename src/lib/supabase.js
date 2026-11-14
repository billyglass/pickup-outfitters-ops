import { createClient } from '@supabase/supabase-js'

// Same pattern as the Installer Job Tracker: env vars, local-mode fallback.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      // detectSessionInUrl: parse the #access_token=...&type=invite /
      // type=recovery hash from Supabase invite / reset links into a
      // session. Without this, an invited user lands with no session.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
