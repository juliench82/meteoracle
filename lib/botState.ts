import { createServerClient } from './supabase'

export interface BotState {
  enabled:  boolean
  dry_run:  boolean
}

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
      .select('enabled, dry_run')
      .eq('id', 1)
      .single()

    if (error || !data) {
      console.error('[botState] read failed, failing closed:', error?.message)
      return { enabled: false, dry_run: true }
    }

    return { enabled: data.enabled, dry_run: data.dry_run }
  } catch (error) {
    console.error('[botState] Supabase error, failing closed:', error)
    return { enabled: false, dry_run: true }
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
