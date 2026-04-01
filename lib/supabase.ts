import { createClient } from '@supabase/supabase-js'

// Supabase new integration (2025+): SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
// Legacy fallbacks: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL!

const supabaseAnonKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Browser client (read-only, safe to expose)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server client (full access — only use in API routes / server components)
export function createServerClient() {
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })
}
