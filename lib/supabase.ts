import { createClient } from '@supabase/supabase-js'

function getUrl(): string {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) throw new Error('SUPABASE_URL is not set')
  return url
}

function getPublicKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  return key
}

function getServiceKey(): string {
  const key =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is not set')
  return key
}

export function getSupabaseUrl(): string {
  return getUrl()
}

export function getSupabaseSecretKey(): string {
  return getServiceKey()
}

export function getSupabaseRestHeaders(prefer: 'minimal' | 'representation' = 'minimal') {
  const key = getServiceKey()
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: `return=${prefer}`,
  }

  // Legacy JWT service_role keys require Authorization. New sb_secret keys are
  // gateway API keys; sending only apikey lets Supabase mint the upstream JWT.
  if (!key.startsWith('sb_')) {
    headers.Authorization = `Bearer ${key}`
  }

  return headers
}

// Browser client (read-only, safe to expose)
export function getSupabase() {
  return createClient(getUrl(), getPublicKey())
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
