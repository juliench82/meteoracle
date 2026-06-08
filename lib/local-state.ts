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

export function saveOpenLpPositions(positions: OpenLpPosition[]) {
  atomicWriteJson(OPEN_POSITIONS_FILE, positions)
}
