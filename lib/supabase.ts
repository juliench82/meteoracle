import { createClient } from '@supabase/supabase-js'

function getUrl(): string {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL is not set')
  return url
}

function getAnonKey(): string {
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!key) throw new Error('SUPABASE_PUBLISHABLE_KEY is not set')
  return key
}

function getServiceKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set')
  return key
}

// Browser client (read-only, safe to expose)
export function getSupabase() {
  return createClient(getUrl(), getAnonKey())
}

// Keep named export for any existing imports of `supabase`
export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
  get(_t, prop) {
    return (getSupabase() as never)[prop as never]
  },
})

// Server client (full access — only use in API routes / server components)
export function createServerClient() {
  return createClient(getUrl(), getServiceKey(), {
    auth: { persistSession: false },
  })
}
