/**
 * lib/botState.ts
 *
 * Bot control state (enabled, dry_run, paused, etc.) stored in local JSON.
 * No Supabase dependency.
 */

import * as fs from 'fs'
import * as path from 'path'

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

function readState(): BotState {
  ensureDir()
  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE }
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
  ensureDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
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
