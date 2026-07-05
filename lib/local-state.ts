/**
 * lib/local-state.ts
 *
 * Minimal local state for open LP positions.
 *
 * Data lives in the state/ directory as JSON files (atomic writes for durability).
 * No external database dependency.
 */

import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteJson } from './atomic-write'
import { sendAlert } from '@/bot/alerter'

const STATE_DIR = path.join(process.cwd(), 'state')
const OPEN_POSITIONS_FILE = path.join(STATE_DIR, 'open-lp-positions.json')

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  }
}

export interface OpenLpPosition {
  id: string
  symbol: string
  mint: string
  pool_address: string
  position_pubkey: string
  strategy_id: string
  sol_deposited: number
  status: string

  // Exit tracking (written by monitor + open path)
  oor_since?: string | null
  fee_tvl_samples?: Array<{ ts: number; fee_tvl_24h: number }>
  last_fee_tvl_4h_avg?: number
  last_net_pnl_pct?: number
  close_reason?: string

  // Stranded sell recovery (written by retryStrandedSells + close on swap failure)
  sell_failed_at?: string
  stranded_recovered_at?: string
  stranded_recovered_sig?: string
  last_stranded_check_at?: string

  // Free-form bag for strategy params persisted at open time + live metrics
  [key: string]: any
}

export function getOpenLpPositions(): OpenLpPosition[] {
  ensureStateDir()
  if (!fs.existsSync(OPEN_POSITIONS_FILE)) return []
  try {
    const data = JSON.parse(fs.readFileSync(OPEN_POSITIONS_FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

let writeQueue = Promise.resolve()
let consecutiveWriteFailures = 0

export function saveOpenLpPositions(positions: OpenLpPosition[]) {
  // Serialize all writes to prevent lost updates from concurrent forks during awaits
  writeQueue = writeQueue.then(() => {
    atomicWriteJson(OPEN_POSITIONS_FILE, positions)
    consecutiveWriteFailures = 0
  }).catch(err => {
    console.error('[local-state] save failed:', err)
    consecutiveWriteFailures++
    if (consecutiveWriteFailures >= 3) {
      console.error('[local-state] 3+ consecutive write failures — pausing bot')
      sendAlert({ type: 'error', message: '[local-state] state write failed 3+ times — pausing trading until resolved' }).catch(() => {})
      import('@/lib/botState').then(m => (m as any).setBotState?.({ paused: true })).catch(() => {})
      consecutiveWriteFailures = 0 // reset after action
    }
  })
}

export async function flushStateWrites(): Promise<void> {
  try { await writeQueue } catch {}
}

/**
 * Safe merge for batched monitor updates.
 * The read-modify-write is performed inside a single queued thunk to ensure atomicity.
 * Always reloads latest list (captures any concurrent adds from scanner) then overlays patches by id.
 * Prevents lost-update races between monitor and stranded-sell recovery etc.
 * Returns a promise that resolves when this update's write has been enqueued and executed.
 */
export async function applyMonitorUpdates(updates: Array<{ id: string; patch: Partial<OpenLpPosition> }>): Promise<void> {
  if (!updates || updates.length === 0) return
  const thisWork = writeQueue.then(() => {
    const all = getOpenLpPositions()
    let changed = false
    for (const { id, patch } of updates) {
      const idx = all.findIndex((p: OpenLpPosition) => p.id === id)
      if (idx !== -1 && patch && Object.keys(patch).length > 0) {
        Object.assign(all[idx], patch)
        changed = true
      }
    }
    if (changed) {
      atomicWriteJson(OPEN_POSITIONS_FILE, all)
    }
    consecutiveWriteFailures = 0
  }).catch(err => {
    console.error('[local-state] applyMonitorUpdates failed:', err)
    consecutiveWriteFailures++
    if (consecutiveWriteFailures >= 3) {
      console.error('[local-state] 3+ consecutive write failures — pausing bot')
      sendAlert({ type: 'error', message: '[local-state] state write failed 3+ times — pausing trading until resolved' }).catch(() => {})
      import('@/lib/botState').then(m => (m as any).setBotState?.({ paused: true })).catch(() => {})
      consecutiveWriteFailures = 0
    }
  })
  writeQueue = thisWork
  return thisWork
}
