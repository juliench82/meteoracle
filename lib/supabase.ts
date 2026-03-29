import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Browser client (read-only, safe to expose)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server client (full access — only use in API routes / server components)
export function createServerClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY!
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })
}
