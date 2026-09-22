/**
 * lib/trade-ledger.ts
 *
 * Append-only local ledger of CLOSED positions (additive, non-trading).
 *
 * - Writes state/trade-log.json with the atomic writer.
 * - Dedupes by record id.
 * - Own serialized write queue + full try/catch: a ledger failure can NEVER
 *   throw into or alter the trading path (fire-and-forget by design).
 *
 * Real values live ONLY in state/ on the founder's machine. Nothing here is
 * ever published; the publish/redaction pipeline is scripts/publish-trade-log.ts.
 */

import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteJson } from './atomic-write'

export type TradeMode = 'dry_run' | 'live'

/**
 * Schema of one closed-trade ledger row. Every field is present on every row;
 * numeric fields are null when unknown.
 */
export interface TradeRecord {
  id: string
  symbol: string
  mode: TradeMode
  opened_at: string
  closed_at: string
  close_reason: string
  sol_deposited: number | null
  net_pnl_pct: number | null
  last_fee_tvl_4h_avg: number | null
  fees_sol: number | null
  il_sol: number | null
  gas_sol: number | null
  rent_sol: number | null
}

const DEFAULT_TRADE_LOG_PATH = (): string => path.join(process.cwd(), 'state', 'trade-log.json')

// Own serialized append queue — independent from local-state's write queue.
let writeQueue: Promise<void> = Promise.resolve()

/** Builds a ledger row from a stored position object (used by the close hook). */
export function buildCloseTradeRecord(
  position: { [key: string]: unknown },
  closeReason: string,
  closedAt: string,
): TradeRecord {
  return {
    id: String(position.id ?? ''),
    symbol: String(position.symbol ?? 'unknown'),
    mode: position.dry_run === true ? 'dry_run' : 'live',
    opened_at: typeof position.opened_at === 'string' ? position.opened_at : '',
    closed_at: closedAt,
    close_reason: closeReason,
    sol_deposited:
      typeof position.sol_deposited === 'number' && Number.isFinite(position.sol_deposited)
        ? position.sol_deposited
        : null,
    net_pnl_pct:
      typeof position.last_net_pnl_pct === 'number' && Number.isFinite(position.last_net_pnl_pct)
        ? position.last_net_pnl_pct
        : null,
    last_fee_tvl_4h_avg:
      typeof position.last_fee_tvl_4h_avg === 'number' &&
      Number.isFinite(position.last_fee_tvl_4h_avg)
        ? position.last_fee_tvl_4h_avg
        : null,
    fees_sol: null,
    il_sol: null,
    gas_sol: null,
    rent_sol: null,
  }
}

/** Reads the ledger (defaults to state/trade-log.json under the caller's cwd). */
export function readTradeLog(filePath?: string): TradeRecord[] {
  const target = filePath ?? DEFAULT_TRADE_LOG_PATH()
  try {
    if (!fs.existsSync(target)) return []
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    return Array.isArray(parsed) ? (parsed as TradeRecord[]) : []
  } catch {
    return []
  }
}

/**
 * Appends one record to the ledger. Dedupes by id (first write wins).
 *
 * Never rejects: all failures are caught and logged as warnings, so callers —
 * including the trading hot path — can fire-and-forget.
 */
export async function appendTradeRecord(record: TradeRecord, filePath?: string): Promise<void> {
  const target = filePath ?? DEFAULT_TRADE_LOG_PATH()
  writeQueue = writeQueue
    .then(() => {
      const rows = readTradeLog(target)
      if (rows.some((r) => r.id === record.id)) return
      rows.push(record)
      atomicWriteJson(target, rows)
    })
    .catch((err) => {
      console.warn('[trade-ledger] append failed (non-fatal, trading path unaffected):', err)
    })
  return writeQueue
}

/** Awaits any in-flight ledger writes (for tests / shutdown). Never rejects. */
export async function flushTradeLogWrites(): Promise<void> {
  try {
    await writeQueue
  } catch {
    // queue never rejects by construction; swallow defensively anyway
  }
}