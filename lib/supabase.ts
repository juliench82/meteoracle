/**
 * lib/supabase.ts
 * 
 * Supabase is being removed in favor of local-state + local-logger.
 * This module now throws on any use so we can find and remove remaining calls.
 */
export function createServerClient() {
  throw new Error(
    "Supabase has been removed from this project. " +
    "Use local-state (state/ folder) and lib/log.ts instead of direct DB access."
  );
}
