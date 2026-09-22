/**
 * scripts/publish-trade-log.ts
 *
 * Generates the SAFE, publishable trade-log artifacts into trades/:
 *   - trades/trade-log.json          redacted real rows (monetary fields -> null)
 *   - trades/trade-log.synthetic.json deterministic built-in demo fixture (>=30 rows)
 *
 * RULES (workflow data boundary):
 *   - Real values exist ONLY in state/trade-log.json on the founder's machine.
 *   - STRUCTURAL fields (id, symbol, opened_at, closed_at, mode, close_reason) are
 *     kept; every MONETARY field is emitted as `null` with a per-row redacted flag.
 *   - Fail-closed redaction self-check: the script scans its OWN output for any
 *     32-44 char base58 token (wallet/pubkey/mint/pool addresses) and for any
 *     non-null monetary value. Any hit -> exits non-zero and writes nothing.
 *   - Deterministic: same input -> byte-identical output (rows sorted by closed_at
 *     then id; fixed field order; JSON with 2-space indent; fixed synthetic table).
 *   - Missing/empty state/trade-log.json is NOT an error: it emits an empty
 *     redacted log (with a notice) plus the synthetic artifact.
 *
 * Publishing real values requires the founder's explicit approval (workflow
 * boundary) — this script can never emit real monetary values by construction.
 */

import * as fs from 'fs'
import * as path from 'path'
import { readTradeLog, type TradeRecord } from '../lib/trade-ledger'

const STATE_LOG_PATH = path.join(process.cwd(), 'state', 'trade-log.json')
const TRADES_DIR = path.join(process.cwd(), 'trades')
const REDACTED_LOG_PATH = path.join(TRADES_DIR, 'trade-log.json')
const SYNTHETIC_LOG_PATH = path.join(TRADES_DIR, 'trade-log.synthetic.json')

interface EmittedRow {
  id: string
  symbol: string
  mode: 'dry_run' | 'live'
  opened_at: string
  closed_at: string
  close_reason: string
  sol_deposited: null
  net_pnl_pct: null
  last_fee_tvl_4h_avg: null
  fees_sol: null
  il_sol: null
  gas_sol: null
  rent_sol: null
  redacted: true
}

const MONETARY_KEYS = [
  'sol_deposited',
  'net_pnl_pct',
  'last_fee_tvl_4h_avg',
  'fees_sol',
  'il_sol',
  'gas_sol',
  'rent_sol',
] as const

// Solana base58 address pattern (wallet/pubkey/mint/pool addresses).
// 32-44 chars from the base58 alphabet, word-bounded.
const BASE58_TOKEN_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g

const DATA_POLICY = {
  redaction_policy:
    'All monetary fields (sol_deposited, net_pnl_pct, last_fee_tvl_4h_avg, ' +
    'fees_sol, il_sol, gas_sol, rent_sol) are emitted as null with a per-row ' +
    'redacted:true flag. Only structural fields (id, symbol, opened_at, ' +
    'closed_at, mode, close_reason) are preserved.',
  never_published: [
    'Wallet private keys or public keys',
    'Position pubkeys',
    'Pool addresses',
    'Token mints (base58 addresses)',
    'Real SOL amounts',
    'Real fees / IL / gas / rent',
    'Real net PnL',
    'Real names, contact info, Telegram IDs, chat IDs',
  ],
  note: 'Synthetic/redacted artifacts only. Publishing real values requires the founder\u2019s explicit approval.',
}

function toRow(rec: TradeRecord): EmittedRow {
  return {
    id: rec.id,
    symbol: rec.symbol,
    mode: rec.mode,
    opened_at: rec.opened_at,
    closed_at: rec.closed_at,
    close_reason: rec.close_reason,
    sol_deposited: null,
    net_pnl_pct: null,
    last_fee_tvl_4h_avg: null,
    fees_sol: null,
    il_sol: null,
    gas_sol: null,
    rent_sol: null,
    redacted: true,
  }
}

/** Deterministic fixed demo table: 34 closed rows, all exit rules, both modes. */
function buildSyntheticRows(): EmittedRow[] {
  const reasons = [
    'fee_tvl_yield_low',
    'oor',
    'net_pnl_sl',
    'max_duration',
    'manual_close',
    'sell_failed',
  ] as const
  const symbols = [
    'DEMO-VOLT', 'DEMO-NEBULA', 'DEMO-CREST', 'DEMO-PULSE', 'DEMO-FLUX',
    'DEMO-EMBER', 'DEMO-HALO', 'DEMO-VERVE', 'DEMO-ORBIT', 'DEMO-LUME',
    'DEMO-KITE', 'DEMO-NOVA', 'DEMO-ZEN', 'DEMO-QUILL', 'DEMO-ARIA', 'DEMO-MINT',
  ] as const
  const base = Date.parse('2026-01-05T08:00:00.000Z')
  const rows: EmittedRow[] = []
  for (let i = 1; i <= 34; i++) {
    const openedAt = new Date(base + (i - 1) * 13 * 3_600_000).toISOString()
    const closedAt = new Date(Date.parse(openedAt) + ((i % 5) + 1) * 4 * 3_600_000).toISOString()
    rows.push({
      id: `demo-${String(i).padStart(4, '0')}`,
      symbol: symbols[(i - 1) % symbols.length],
      mode: i % 2 === 1 ? 'dry_run' : 'live',
      opened_at: openedAt,
      closed_at: closedAt,
      close_reason: reasons[(i - 1) % reasons.length],
      sol_deposited: null,
      net_pnl_pct: null,
      last_fee_tvl_4h_avg: null,
      fees_sol: null,
      il_sol: null,
      gas_sol: null,
      rent_sol: null,
      redacted: true,
    })
  }
  return rows
}

function sortRows(rows: EmittedRow[]): EmittedRow[] {
  return [...rows].sort((a, b) =>
    a.closed_at.localeCompare(b.closed_at) || a.id.localeCompare(b.id)
  )
}

function scanForLeaks(text: string, rows: EmittedRow[], label: string): string[] {
  const problems: string[] = []
  const tokenMatches = text.match(BASE58_TOKEN_RE) ?? []
  if (tokenMatches.length > 0) {
    problems.push(
      `${label}: found ${tokenMatches.length} base58 token(s) (possible wallet/pubkey/mint/pool address): ${tokenMatches.slice(0, 3).join(' ')}`
    )
  }
  for (const row of rows) {
    for (const key of MONETARY_KEYS) {
      const value = (row as unknown as Record<string, unknown>)[key]
      if (value !== null && value !== undefined) {
        problems.push(`${label}: row ${row.id} has non-null monetary field ${key}=${String(value)}`)
      }
    }
  }
  return problems
}

function failClosed(problems: string[]): never {
  console.error('[publish-trade-log] REDACTION SELF-CHECK FAILED — refusing to write anything.')
  for (const p of problems) {
    console.error(`  - ${p}`)
  }
  console.error('[publish-trade-log] No files were written. Fix the source data and re-run.')
  process.exit(1)
}

function main(): void {
  const sourceExists = fs.existsSync(STATE_LOG_PATH)
  const sourceRecords = sourceExists ? readTradeLog(STATE_LOG_PATH) : []

  // --- Redacted real log -------------------------------------------------
  let redactedRows: EmittedRow[] = []
  let notice: string | undefined
  if (!sourceExists || sourceRecords.length === 0) {
    notice =
      sourceExists
        ? 'state/trade-log.json exists but contains no rows yet — the ledger starts accruing on the next closed position.'
        : 'state/trade-log.json not found — nothing to redact yet; the ledger starts accruing on the next closed position.'
  } else {
    redactedRows = sortRows(sourceRecords.map(toRow))
  }
  const redactedLog = {
    version: 1,
    data_policy: DATA_POLICY,
    rows: redactedRows,
    ...(notice ? { notice } : {}),
  }
  const redactedText = JSON.stringify(redactedLog, null, 2) + '\n'

  // --- Synthetic demo ----------------------------------------------------
  const syntheticLog = {
    version: 1,
    synthetic: true,
    data_policy: DATA_POLICY,
    rows: sortRows(buildSyntheticRows()),
  }
  const syntheticText = JSON.stringify(syntheticLog, null, 2) + '\n'

  // --- Fail-closed redaction self-check (BEFORE any write) ---------------
  const problems = [
    ...scanForLeaks(redactedText, redactedRows, 'trades/trade-log.json'),
    ...scanForLeaks(syntheticText, syntheticLog.rows, 'trades/trade-log.synthetic.json'),
  ]
  if (problems.length > 0) {
    failClosed(problems)
  }

  // --- Deterministic writes ----------------------------------------------
  fs.mkdirSync(TRADES_DIR, { recursive: true })
  fs.writeFileSync(REDACTED_LOG_PATH, redactedText)
  fs.writeFileSync(SYNTHETIC_LOG_PATH, syntheticText)

  console.log(`[publish-trade-log] wrote ${REDACTED_LOG_PATH} (${redactedRows.length} redacted row(s))`)
  console.log(`[publish-trade-log] wrote ${SYNTHETIC_LOG_PATH} (${syntheticLog.rows.length} synthetic row(s))`)
  if (notice) {
    console.log(`[publish-trade-log] notice: ${notice}`)
  }
  console.log('[publish-trade-log] redaction self-check passed: 0 base58 tokens, 0 non-null monetary values.')
}

main()