import { createServerClient } from '@/lib/supabase'

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = toNumber(value)
    if (n !== null) return n
  }
  return null
}

function getTodayMidnightIso(): string {
  const iso = new Date().toISOString()
  return `${iso.slice(0, 10)}T00:00:00.000Z`
}

function resolveLossSol(row: Record<string, unknown>): number {
  const depositedSol = Math.max(0, toNumber(row.sol_deposited) ?? 0)
  if (depositedSol <= 0) return 0

  const metadata = toRecord(row.metadata)
  const explicitFinalValueSol = firstNumber(
    metadata.final_value_sol,
    metadata.finalValueSol,
    metadata.exit_value_sol,
    metadata.close_value_sol,
  )
  if (explicitFinalValueSol !== null) {
    return Math.max(0, depositedSol - Math.max(0, explicitFinalValueSol))
  }

  const pnlSol = firstNumber(
    row.pnl_sol,
    metadata.pnl_sol,
  )
  if (pnlSol !== null) {
    return Math.max(0, -pnlSol)
  }

  const pnlUsd = firstNumber(
    row.realized_pnl_usd,
    row.pnl_usd,
    metadata.realized_pnl_usd,
    metadata.pnl_usd,
    metadata.total_pnl_usd,
    metadata.position_pnl_usd,
  )
  const solPriceUsd = firstNumber(
    metadata.exit_sol_price_usd,
    metadata.current_sol_price_usd,
    metadata.sol_price_usd,
    metadata.entry_sol_price_usd,
  )
  if (pnlUsd !== null && solPriceUsd !== null && solPriceUsd > 0) {
    return Math.max(0, -(pnlUsd / solPriceUsd))
  }

  const positionValueUsd = firstNumber(row.position_value_usd, metadata.position_value_usd)
  if (positionValueUsd !== null && solPriceUsd !== null && solPriceUsd > 0) {
    const finalValueSol = positionValueUsd / solPriceUsd
    return Math.max(0, depositedSol - finalValueSol)
  }

  return 0
}

export async function isDailyLossLimitHit(): Promise<boolean> {
  const maxDailyLossSol = parseFloat(process.env.MAX_DAILY_LOSS_SOL ?? '0')
  if (!Number.isFinite(maxDailyLossSol) || maxDailyLossSol <= 0) return false

  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .select('sol_deposited, pnl_sol, pnl_usd, realized_pnl_usd, position_value_usd, metadata')
    .eq('status', 'closed')
    .eq('dry_run', false)
    .gte('closed_at', getTodayMidnightIso())

  if (error) {
    console.warn(`[circuit-breaker] failed to read daily closed positions: ${error.message}`)
    return false
  }

  const totalLossSol = (data ?? [])
    .reduce((sum, row) => sum + resolveLossSol(row as Record<string, unknown>), 0)

  if (totalLossSol > maxDailyLossSol) {
    console.warn(
      `[circuit-breaker] daily loss limit hit: ${totalLossSol.toFixed(4)} SOL > ${maxDailyLossSol.toFixed(4)} SOL`,
    )
    return true
  }

  return false
}
