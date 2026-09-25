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

/**
 * Serialized write queue for open-lp-positions.json.
 *
 * INVARIANT (H2): `writeQueue` is ALWAYS a promise that cannot reject.
 * A failed write must never poison the queue. Every work item is chained on
 * `writeQueue.catch(() => {})`, so an earlier rejection can never skip a later
 * call's `.then()` mutator, and the promise stored back is a tail that cannot
 * reject. (The previous implementation stored the *rejected* promise back into
 * `writeQueue`, so every later call skipped its `.then()` mutator — the write
 * was silently lost on a healthy disk — and re-ran the stale `.catch()`,
 * bumping the failure counter once per subsequent call.)
 */
let writeQueue: Promise<void> = Promise.resolve()
let consecutiveWriteFailures = 0

/**
 * Account for exactly one genuinely failed write.
 * Incremented once per failed write (never once per poisoned re-run), reset to
 * 0 by the next successful write. Three genuinely consecutive failures pause
 * the bot and alert once.
 */
function recordWriteFailure(err: unknown, context: string): void {
  console.error(`[local-state] ${context} failed:`, err)
  console.error('[local-state] write failed — possible disk/permissions issue:', err)
  consecutiveWriteFailures++
  if (consecutiveWriteFailures >= 3) {
    console.error('[local-state] 3+ consecutive write failures — pausing bot')
    try {
      sendAlert({ type: 'error', message: '[local-state] state write failed 3+ times — pausing trading until resolved' }).catch(() => {})
      import('@/lib/botState').then(m => (m as any).setBotState?.({ paused: true })).catch(() => {})
    } catch (alertErr) {
      console.error('[local-state] failed to emit write-failure alert:', alertErr)
    }
    consecutiveWriteFailures = 0 // reset AFTER sendAlert
  }
}

/**
 * Run `mutator` inside the serialized write queue.
 *
 * - the chain head absorbs any earlier failure, so the mutator ALWAYS runs;
 * - a successful run resets the consecutive-failure counter;
 * - a failed run is accounted exactly once and feeds the 3-strike pause;
 * - the promise stored back into `writeQueue` never rejects;
 * - the returned promise resolves/rejects with THIS call's own outcome, so
 *   callers that await it keep getting real signal.
 */
function enqueueWrite(mutator: () => void, context: string): Promise<void> {
  const thisWork = writeQueue
    .catch(() => {})
    .then(() => {
      mutator()
      consecutiveWriteFailures = 0
    })
  // Terminal handler keeps the stored tail non-rejecting (the queue can no longer be poisoned).
  writeQueue = thisWork.then(
    () => undefined,
    (err) => { recordWriteFailure(err, context) }
  )
  return thisWork
}

export function saveOpenLpPositions(positions: OpenLpPosition[]): Promise<void> {
  // Serialize all writes to prevent lost updates from concurrent forks during awaits.
  // No void-swallow: the returned promise rejects when THIS write genuinely failed
  // so callers can observe it, while the shared queue stays healthy.
  return enqueueWrite(() => {
    atomicWriteJson(OPEN_POSITIONS_FILE, positions)
  }, 'save')
}

export async function flushStateWrites(): Promise<void> {
  try { await writeQueue } catch {}
}

/**
 * Safe merge for batched monitor updates.
 * The read-modify-write (getOpenLpPositions + patch + atomic write) is performed inside a single queued thunk
 * chained through writeQueue to ensure atomicity as a unit (per fix instruction).
 * Always reloads latest list (captures any concurrent adds from scanner) then overlays patches by id.
 * Prevents lost-update races between monitor and stranded-sell recovery etc.
 * Returns a promise that resolves when this update's write has been executed and
 * rejects when this update's write genuinely failed.
 * Callers must await it.
 */
export async function applyMonitorUpdates(updates: Array<{ id: string; patch: Partial<OpenLpPosition> }>): Promise<void> {
  if (!updates || updates.length === 0) return
  return enqueueWrite(() => {
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
  }, 'applyMonitorUpdates')
}

/**
 * General safe RMW helper for position state.
 * The mutator receives the latest array (reloaded inside the queue) and can mutate it in place.
 * Write happens atomically inside the serialized writeQueue.
 * Prevents lost updates from concurrent get-modify-save across monitor, scanner, executor, swap, etc.
 * Callers should await when possible.
 */
export async function withQueuedUpdate(
  mutator: (positions: OpenLpPosition[]) => void
): Promise<void> {
  if (typeof mutator !== 'function') return
  return enqueueWrite(() => {
    const all = getOpenLpPositions()
    mutator(all)
    atomicWriteJson(OPEN_POSITIONS_FILE, all)
  }, 'withQueuedUpdate')
}