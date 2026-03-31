import { createClient } from '@supabase/supabase-js'

// Vercel's Supabase integration sets SUPABASE_URL / SUPABASE_ANON_KEY.
// NEXT_PUBLIC_ variants are also present but fall back gracefully.
const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL!

const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Browser client (read-only, safe to expose)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server client (full access — only use in API routes / server components)
export function createServerClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })
}
