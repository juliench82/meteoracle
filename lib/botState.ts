import { createServerClient } from './supabase'

export interface BotState {
  enabled:      boolean
  dry_run:      boolean
  is_running:   boolean
  running_since: string | null
}

/** Lock TTL: if a tick started more than 90s ago and is still flagged running,
 *  treat it as stale (Vercel killed it) and allow a new lock acquisition. */
const LOCK_TTL_MS = 90_000

/**
 * Read the current bot state from Supabase.
 * Falls back to { enabled: false, dry_run: true } on any error. Runtime
 * control state is safety-critical, so DB uncertainty must pause bot work.
 */
export async function getBotState(): Promise<BotState> {
  try {
    const supabase = createServerClient()
    const { data, error } = await supabase
      .from('bot_state')
      .select('enabled, dry_run, is_running, running_since')
      .eq('id', 1)
      .single()

    if (error || !data) {
      console.error('[botState] read failed, failing closed:', error?.message)
      return { enabled: false, dry_run: true, is_running: false, running_since: null }
    }

    return {
      enabled:      data.enabled,
      dry_run:      data.dry_run,
      is_running:   data.is_running ?? false,
      running_since: data.running_since ?? null,
    }
  } catch (error) {
    console.error('[botState] Supabase error, failing closed:', error)
    return { enabled: false, dry_run: true, is_running: false, running_since: null }
  }
}

/**
 * Persist a partial update to bot_state.
 * Throws on failure so callers (Telegram commands) can surface the error.
 */
export async function setBotState(patch: Partial<BotState>): Promise<void> {
  const supabase = createServerClient()
  const { error } = await supabase
    .from('bot_state')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1)

  if (error) {
    console.error('[botState] write failed:', error.message)
    throw new Error(`Failed to update bot_state: ${error.message}`)
  }
}

/**
 * Attempt to acquire a distributed run lock.
 *
 * Returns true if the lock was acquired (caller should proceed).
 * Returns false if another invocation is already running and within TTL
 * (caller must abort and reply "already running").
 *
 * Stale locks (running_since > LOCK_TTL_MS ago) are automatically cleared
 * to prevent a Vercel timeout from permanently blocking the bot.
 */
export async function acquireRunLock(): Promise<boolean> {
  const state = await getBotState()

  if (state.is_running && state.running_since) {
    const age = Date.now() - new Date(state.running_since).getTime()
    if (age < LOCK_TTL_MS) {
      return false // another invocation is live
    }
    // stale lock — fall through and overwrite
    console.warn(`[botState] stale lock detected (age ${Math.round(age / 1000)}s), overwriting`)
  }

  await setBotState({ is_running: true, running_since: new Date().toISOString() })
  return true
}

/**
 * Release the distributed run lock.
 * Always call this in a finally block after acquireRunLock() returns true.
 */
export async function releaseRunLock(): Promise<void> {
  await setBotState({ is_running: false, running_since: null }).catch(err =>
    console.error('[botState] failed to release run lock:', err),
  )
}
