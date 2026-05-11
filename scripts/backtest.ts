/**
 * scripts/backtest.ts
 *
 * Replay closed lp_positions rows and compute per-strategy-version P&L metrics.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts
 *   npx tsx scripts/backtest.ts --strategy evil-panda
 *   npx tsx scripts/backtest.ts --strategy evil-panda --version v1.0
 *   npx tsx scripts/backtest.ts --days 30
 *   npx tsx scripts/backtest.ts --csv
 *
 * Flags:
 *   --strategy <id>      Filter to a single strategy id
 *   --version  <ver>     Filter to a specific strategy_version in metadata
 *   --days     <n>       Look back N days (default: 90)
 *   --csv                Print CSV to stdout instead of the table
 *
 * Requires: SUPABASE_URL + SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 */

import 'dotenv/config'
import { createServerClient } from '@/lib/supabase'

// ── CLI args ──────────────────────────────────────────────────────────────────

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

const filterStrategy = arg('--strategy')
const filterVersion  = arg('--version')
const lookbackDays   = Number(arg('--days') ?? 90)
const csvMode        = process.argv.includes('--csv')

// ── Types ─────────────────────────────────────────────────────────────────────

interface PositionRow {
  id:                string
  strategy_id:       string
  token_symbol:      string
  token_address:     string
  sol_deposited:     number
  realized_pnl_usd:  number | null
  claimable_fees_usd: number | null
  close_reason:      string | null
  opened_at:         string
  closed_at:         string | null
  metadata:          Record<string, unknown> | null
}

interface BucketKey {
  strategy_id:      string
  strategy_version: string
  close_reason:     string
}

interface Bucket {
  key:          BucketKey
  count:        number
  sol_in:       number
  pnl_usd:      number
  fees_usd:     number
  durations_h:  number[]
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchPositions(): Promise<PositionRow[]> {
  const db    = createServerClient()
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

  let query = db
    .from('lp_positions')
    .select(
      'id, strategy_id, token_symbol, token_address, sol_deposited, ' +
      'realized_pnl_usd, claimable_fees_usd, close_reason, ' +
      'opened_at, closed_at, metadata',
    )
    .eq('status', 'closed')
    .gte('closed_at', since)
    .order('closed_at', { ascending: false })

  if (filterStrategy) query = query.eq('strategy_id', filterStrategy)

  const { data, error } = await query
  if (error) throw new Error(`Supabase query failed: ${error.message}`)
  return (data ?? []) as PositionRow[]
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

function bucketKey(row: PositionRow): string {
  const version = (row.metadata?.strategy_version as string | undefined) ?? 'unknown'
  const reason  = row.close_reason ?? 'unknown'
  return `${row.strategy_id}|${version}|${reason}`
}

function aggregate(rows: PositionRow[]): Bucket[] {
  const map = new Map<string, Bucket>()

  for (const row of rows) {
    if (filterVersion) {
      const ver = (row.metadata?.strategy_version as string | undefined) ?? 'unknown'
      if (ver !== filterVersion) continue
    }

    const k = bucketKey(row)
    if (!map.has(k)) {
      map.set(k, {
        key: {
          strategy_id:      row.strategy_id,
          strategy_version: (row.metadata?.strategy_version as string | undefined) ?? 'unknown',
          close_reason:     row.close_reason ?? 'unknown',
        },
        count:       0,
        sol_in:      0,
        pnl_usd:     0,
        fees_usd:    0,
        durations_h: [],
      })
    }

    const b = map.get(k)!
    b.count    += 1
    b.sol_in   += row.sol_deposited ?? 0
    b.pnl_usd  += row.realized_pnl_usd  ?? 0
    b.fees_usd += row.claimable_fees_usd ?? 0

    if (row.opened_at && row.closed_at) {
      const h = (Date.parse(row.closed_at) - Date.parse(row.opened_at)) / 3_600_000
      if (h > 0) b.durations_h.push(h)
    }
  }

  return [...map.values()].sort((a, b) => {
    const s = a.key.strategy_id.localeCompare(b.key.strategy_id)
    if (s !== 0) return s
    const v = a.key.strategy_version.localeCompare(b.key.strategy_version)
    if (v !== 0) return v
    return a.key.close_reason.localeCompare(b.key.close_reason)
  })
}

// ── Summary row per strategy+version (across close_reasons) ──────────────────

interface Summary {
  strategy_id:      string
  strategy_version: string
  total_positions:  number
  sol_in:           number
  total_pnl_usd:    number
  total_fees_usd:   number
  avg_pnl_usd:      number
  avg_fees_usd:     number
  avg_duration_h:   number
  win_rate_pct:     number
  roi_pct:          number
  breakdown:        Record<string, number>  // close_reason → count
}

function summarise(buckets: Bucket[], solPriceUsd: number): Summary[] {
  const summaryMap = new Map<string, Summary>()

  for (const b of buckets) {
    const k = `${b.key.strategy_id}|${b.key.strategy_version}`
    if (!summaryMap.has(k)) {
      summaryMap.set(k, {
        strategy_id:      b.key.strategy_id,
        strategy_version: b.key.strategy_version,
        total_positions:  0,
        sol_in:           0,
        total_pnl_usd:    0,
        total_fees_usd:   0,
        avg_pnl_usd:      0,
        avg_fees_usd:     0,
        avg_duration_h:   0,
        win_rate_pct:     0,
        roi_pct:          0,
        breakdown:        {},
      })
    }

    const s = summaryMap.get(k)!
    s.total_positions += b.count
    s.sol_in          += b.sol_in
    s.total_pnl_usd   += b.pnl_usd
    s.total_fees_usd  += b.fees_usd
    s.breakdown[b.key.close_reason] = (s.breakdown[b.key.close_reason] ?? 0) + b.count

    for (const h of b.durations_h) {
      // We'll compute avg below
      ;(s as never as { _dur: number[] })['_dur'] = [
        ...((s as never as { _dur?: number[] })['_dur'] ?? []),
        h,
      ]
    }
  }

  for (const s of summaryMap.values()) {
    if (s.total_positions > 0) {
      s.avg_pnl_usd    = s.total_pnl_usd  / s.total_positions
      s.avg_fees_usd   = s.total_fees_usd / s.total_positions
    }
    const durs = (s as never as { _dur?: number[] })['_dur'] ?? []
    s.avg_duration_h = durs.length > 0 ? durs.reduce((a, b) => a + b, 0) / durs.length : 0

    // win = closed with stop_loss NOT hit, i.e. anything except 'stop_loss'
    const wins = Object.entries(s.breakdown)
      .filter(([reason]) => reason !== 'stop_loss' && reason !== 'manual_stop')
      .reduce((a, [, c]) => a + c, 0)
    s.win_rate_pct = s.total_positions > 0 ? (wins / s.total_positions) * 100 : 0

    // ROI: total_pnl_usd / (sol_in * solPriceUsd) * 100
    const capitalUsd = s.sol_in * solPriceUsd
    s.roi_pct = capitalUsd > 0 ? (s.total_pnl_usd / capitalUsd) * 100 : 0
  }

  return [...summaryMap.values()].sort((a, b) => {
    const s = a.strategy_id.localeCompare(b.strategy_id)
    return s !== 0 ? s : a.strategy_version.localeCompare(b.strategy_version)
  })
}

// ── SOL price (best-effort, non-blocking) ─────────────────────────────────────

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5_000) },
    )
    const json = await res.json() as { solana?: { usd?: number } }
    return json.solana?.usd ?? 150
  } catch {
    return 150  // fallback — only affects ROI % display
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function pct(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function renderTable(summaries: Summary[], buckets: Bucket[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log(' METEORACLE BACKTEST')
  console.log(` Lookback: ${lookbackDays}d${filterStrategy ? ` | strategy: ${filterStrategy}` : ''}${filterVersion ? ` | version: ${filterVersion}` : ''}`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  for (const s of summaries) {
    console.log(`▸ ${s.strategy_id} @ ${s.strategy_version}`)
    console.log(`  positions   : ${s.total_positions}`)
    console.log(`  sol in      : ${s.sol_in.toFixed(4)} SOL`)
    console.log(`  total PnL   : ${usd(s.total_pnl_usd)}`)
    console.log(`  total fees  : ${usd(s.total_fees_usd)}`)
    console.log(`  avg PnL     : ${usd(s.avg_pnl_usd)}`)
    console.log(`  avg fees    : ${usd(s.avg_fees_usd)}`)
    console.log(`  avg dur     : ${s.avg_duration_h.toFixed(1)}h`)
    console.log(`  win rate    : ${pct(s.win_rate_pct)}`)
    console.log(`  ROI         : ${pct(s.roi_pct, 2)}`)
    console.log('  close reasons:')
    for (const [reason, count] of Object.entries(s.breakdown).sort()) {
      console.log(`    ${reason.padEnd(24)} ${count}`)
    }
    console.log()
  }

  // Per-bucket detail
  console.log('─── Close-reason detail ────────────────────────────────────────────')
  console.log(
    'strategy'.padEnd(20) +
    'version'.padEnd(10) +
    'reason'.padEnd(22) +
    'n'.padStart(5) +
    'pnl_usd'.padStart(12) +
    'fees_usd'.padStart(12) +
    'avg_dur_h'.padStart(12),
  )
  console.log('─'.repeat(93))
  for (const b of buckets) {
    const avgDur = b.durations_h.length > 0
      ? (b.durations_h.reduce((a, c) => a + c, 0) / b.durations_h.length).toFixed(1)
      : '–'
    console.log(
      b.key.strategy_id.padEnd(20) +
      b.key.strategy_version.padEnd(10) +
      b.key.close_reason.padEnd(22) +
      String(b.count).padStart(5) +
      usd(b.pnl_usd).padStart(12) +
      usd(b.fees_usd).padStart(12) +
      String(avgDur).padStart(12),
    )
  }
  console.log()
}

function renderCsv(summaries: Summary[]): void {
  const cols = [
    'strategy_id', 'strategy_version', 'total_positions',
    'sol_in', 'total_pnl_usd', 'total_fees_usd',
    'avg_pnl_usd', 'avg_fees_usd', 'avg_duration_h',
    'win_rate_pct', 'roi_pct',
  ]
  console.log(cols.join(','))
  for (const s of summaries) {
    console.log([
      s.strategy_id,
      s.strategy_version,
      s.total_positions,
      s.sol_in.toFixed(4),
      s.total_pnl_usd.toFixed(2),
      s.total_fees_usd.toFixed(2),
      s.avg_pnl_usd.toFixed(2),
      s.avg_fees_usd.toFixed(2),
      s.avg_duration_h.toFixed(1),
      s.win_rate_pct.toFixed(1),
      s.roi_pct.toFixed(2),
    ].join(','))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [rows, solPrice] = await Promise.all([fetchPositions(), getSolPrice()])

  if (rows.length === 0) {
    console.warn('No closed positions found for the given filters.')
    process.exit(0)
  }

  const buckets   = aggregate(rows)
  const summaries = summarise(buckets, solPrice)

  if (csvMode) {
    renderCsv(summaries)
  } else {
    renderTable(summaries, buckets)
    console.log(`SOL price used for ROI calc: $${solPrice} (live CoinGecko)`)
    console.log(`Rows analysed: ${rows.length}`)
  }
}

main().catch((err: unknown) => {
  console.error('backtest failed:', err)
  process.exit(1)
})
