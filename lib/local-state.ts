/**
 * lib/local-state.ts
 *
 * Minimal local state for open positions (LP + Moonboy).
 * Replaces previous Supabase dependency for runtime state.
 *
 * Data lives in the state/ directory as JSON files.
 */

import * as fs from 'fs'
import * as path from 'path'

const STATE_DIR = path.join(process.cwd(), 'state')

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

  // Free-form bag for strategy params persisted at open time + live metrics
  [key: string]: any
}

export interface OpenMoonboy {
  id: string
  symbol: string
  mint: string
  [key: string]: any
}

export function getOpenLpPositions(): OpenLpPosition[] {
  ensureStateDir()
  const file = path.join(STATE_DIR, 'open-lp-positions.json')
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function getOpenMoonboys(): OpenMoonboy[] {
  ensureStateDir()
  const file = path.join(STATE_DIR, 'open-moonboys.json')
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function saveOpenLpPositions(positions: OpenLpPosition[]) {
  ensureStateDir()
  const file = path.join(STATE_DIR, 'open-lp-positions.json')
  fs.writeFileSync(file, JSON.stringify(positions, null, 2))
}

export function saveOpenMoonboys(moonboys: OpenMoonboy[]) {
  ensureStateDir()
  const file = path.join(STATE_DIR, 'open-moonboys.json')
  fs.writeFileSync(file, JSON.stringify(moonboys, null, 2))
}
