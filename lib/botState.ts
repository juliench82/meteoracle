/**
 * lib/botState.ts
 *
 * Bot control state (enabled, dry_run, paused, etc.) stored in local JSON.
 * No Supabase dependency.
 */

import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteJson } from './atomic-write'

const STATE_DIR = path.join(process.cwd(), 'state')
const STATE_FILE = path.join(STATE_DIR, 'bot-state.json')

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
}

export interface BotState {
  enabled: boolean
  dry_run: boolean
  is_running: boolean
  running_since: string | null
  sync_fail_count: number
  paused?: boolean
}

const DEFAULT_STATE: BotState = {
  enabled: false,
  dry_run: true,
  is_running: false,
  running_since: null,
  sync_fail_count: 0,
  paused: false,
}

/**
 * Compute initial bot state when no persisted file exists.
 * Seeds from process.env so that `rm state/bot-state.json && pm2 start ... --update-env`
 * produces a botState that matches the caller's BOT_ENABLED / BOT_DRY_RUN intent.
 * (ENV_FORCED can still force-dry later; this just sets the persisted starting value.)
 */
function getInitialState(): BotState {
  const envDry = process.env.BOT_DRY_RUN === 'true'
  const envEnabled = process.env.BOT_ENABLED === 'true'
  return {
    ...DEFAULT_STATE,
    dry_run: envDry,
    enabled: envEnabled,
  }
}

function readState(): BotState {
  ensureDir()
  if (!fs.existsSync(STATE_FILE)) {
    const initial = getInitialState()
    writeState(initial) // persist immediately so banner + first ticks see consistent file-backed state
    return initial
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(state: BotState) {
  atomicWriteJson(STATE_FILE, state)
}

export async function getBotState(): Promise<BotState> {
  return readState()
}

export async function setBotState(patch: Partial<BotState>): Promise<void> {
  const current = readState()
  const next = { ...current, ...patch }
  writeState(next)
}

export async function incrementSyncFailCount(): Promise<number> {
  const state = readState()
  const next = (state.sync_fail_count || 0) + 1
  await setBotState({ sync_fail_count: next })
  return next
}

export function resetSyncFailCount() {
  setBotState({ sync_fail_count: 0 }).catch(() => {})
}
