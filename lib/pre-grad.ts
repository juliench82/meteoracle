/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Manages the monitoring loop and exit routing for positions opened via the
 * DAMM edge track (strategy_id = 'damm-edge').
 *
 * ISOLATION RULE: Must NOT import anything from bot/monitor.ts or bot/executor.ts.
 */

import { closeDammPosition } from '../bot/damm-executor'
import { sendAlert } from '../bot/alerter'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── DAMM v2 REST: pool stats ──────────────────────────────────────────────────

/**
 * Pool-level stats from the Meteora DAMM v2 REST API.
 * Used for dashboard context (volume, TVL) — not an exit signal.
 *
 * Endpoint: GET https://amm-v2.meteora.ag/pool/{pool_address}
 */
async function fetchDammPoolStats(poolAddress: string): Promise<{
  volume24hUsd: number
  tvlUsd: number
} | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/pool/${poolAddress}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      volume24hUsd: Number(data.trading_volume ?? data.volume_24h ?? 0),
      tvlUsd:       Number(data.pool_tvl        ?? data.tvl        ?? 0),
    }
  } catch {
    return null
  }
}

// ── DAMM v2 REST: per-position claimable fees ─────────────────────────────────

/**
 * Returns the claimable fees for a specific position in USD,
 * mirroring exactly what Meteora's UI shows.
 *
 * Endpoint: GET https://amm-v2.meteora.ag/position/{position_pubkey}
 * Relevant field: fee_pending_usd (sum of both token sides in USD).
 * Returns null on any failure — non-blocking.
 */
async function fetchClaimableFeesUsd(positionPubkey: string): Promise<number | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/position/${positionPubkey}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    // Field variants observed across API versions
    const raw = data.fee_pending_usd ?? data.total_fee_usd ?? data.claimable_fee_usd ?? null
    return raw !== null ? Number(raw) : null
  } catch {
    return null
  }
}

// ── On-chain state fetch ──────────────────────────────────────────────────────

/**
 * Reads current sqrtPrice from DAMM pool state and derives a SOL-denominated
 * price ratio vs entry_price_sol for PnL computation.
 *
 * sqrtPrice in DAMM v2 is a Q64.64 fixed-point number:
 *   price = (sqrtPrice / 2^64)^2
 * Units cancel out in the pricePct calculation — we only need the ratio.
 *
 * Returns null if the RPC call fails so the caller can skip the tick safely.
 */
async function fetchDammPositionState(
  poolAddress: string,
): Promise<{ currentPriceSol: number } | null> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js')
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')

    const connection = new Connection(process.env.RPC_URL!, 'confirmed')
    const sdk = new CpAmm(connection)

    const poolState = await sdk.fetchPoolState(new PublicKey(poolAddress))
    if (!poolState) return null

    const TWO_POW_64 = 2n ** 64n
    const sqrtPriceBig = BigInt(poolState.sqrtPrice.toString())
    const currentPriceSol = Number((sqrtPriceBig * sqrtPriceBig) / (TWO_POW_64 * TWO_POW_64))

    return { currentPriceSol }
  } catch (err) {
    console.error('[PRE-GRAD] fetchDammPositionState failed:', err)
    return null
  }
}

// ── Single-pass monitor ───────────────────────────────────────────────────────

/**
 * checkDammPositions — one evaluation pass over all active DAMM positions.
 *
 * Called directly from the tick route on every cron invocation.
 */
export async function checkDammPositions(): Promise<{ checked: number; exited: number }> {
  const { data: positions, error } = await supabase
    .from('lp_positions')
    .select('*')
    .eq('strategy_id', 'damm-edge')
    .eq('status', 'active')

  if (error) {
    console.error('[PRE-GRAD] DB query error:', error.message)
    return { checked: 0, exited: 0 }
  }

  if (!positions || positions.length === 0) {
    return { checked: 0, exited: 0 }
  }

  console.log(`[PRE-GRAD] Evaluating ${positions.length} DAMM position(s)`)
  let exited = 0

  for (const pos of positions) {
    const ageHours = (Date.now() - new Date(pos.opened_at).getTime()) / (1000 * 60 * 60)
    const solDeposited = Number(pos.sol_deposited ?? 1)

    // All three fetches in parallel — no sequential blocking
    const [onChain, poolStats, claimableFeesUsd] = await Promise.all([
      fetchDammPositionState(pos.pool_address),
      fetchDammPoolStats(pos.pool_address),
      fetchClaimableFeesUsd(pos.position_pubkey),
    ])

    let pnlSol: number
    let pnlPct: number

    if (onChain && onChain.currentPriceSol > 0 && Number(pos.entry_price_sol ?? 0) > 0) {
      const entryPrice = Number(pos.entry_price_sol)
      const pricePct = ((onChain.currentPriceSol - entryPrice) / entryPrice) * 100
      const k = onChain.currentPriceSol / entryPrice
      const ilPct = (2 * Math.sqrt(k) / (1 + k) - 1) * 100
      pnlSol = solDeposited * (pricePct / 100)
      pnlPct = solDeposited > 0 ? (pnlSol / solDeposited) * 100 : 0

      await supabase
        .from('lp_positions')
        .update({
          current_price: onChain.currentPriceSol,
          pnl_sol:       Math.round(pnlSol * 1e6) / 1e6,
          il_pct:        Math.round(ilPct * 100) / 100,
          metadata: {
            ...(pos.metadata ?? {}),
            // Claimable fees in USD — mirrors Meteora UI exactly
            ...(claimableFeesUsd !== null && { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 }),
            // Pool-level context for dashboard
            ...(poolStats && {
              volume_24h_usd:    Math.round(poolStats.volume24hUsd),
              tvl_usd:           Math.round(poolStats.tvlUsd),
              stats_updated_at:  new Date().toISOString(),
            }),
          },
        })
        .eq('id', pos.id)
    } else {
      pnlSol = Number(pos.pnl_sol ?? 0)
      pnlPct = solDeposited > 0 ? (pnlSol / solDeposited) * 100 : 0
      if (!onChain) {
        console.warn(`[PRE-GRAD] RPC miss for ${pos.id} — skipping TP/SL this tick`)
      }
    }

    // ── Exit triggers: max-duration | stop-loss | take-profit ────────────────
    let reason = ''
    if (ageHours > 72)                   reason = 'max-duration'
    else if (onChain && pnlPct <= -30)   reason = 'stop-loss'
    else if (onChain && pnlPct >= 40)    reason = 'take-profit'

    if (reason) {
      const label = pos.symbol ?? pos.mint ?? pos.id
      const feesDisplay = claimableFeesUsd !== null ? `$${claimableFeesUsd.toFixed(2)}` : 'n/a'
      console.log(`[PRE-GRAD] EXIT: ${label} → ${reason} (pnl=${pnlPct.toFixed(1)}% claimable=${feesDisplay})`)
      await handleDammExit(pos.id, reason, pos.symbol ?? pos.mint ?? 'UNKNOWN', pos.opened_at)
      exited++
    }
  }

  return { checked: positions.length, exited }
}

/**
 * startPreGradMonitor — kept for backwards compatibility.
 * No-op shim; monitor is driven by checkDammPositions() in the tick route.
 */
export async function startPreGradMonitor(): Promise<void> {}

// ── Exit handler ──────────────────────────────────────────────────────────────

export async function handleDammExit(
  positionId: string,
  reason: string,
  symbol: string = 'UNKNOWN',
  openedAt?: string,
): Promise<void> {
  const ageMin = openedAt
    ? Math.round((Date.now() - new Date(openedAt).getTime()) / 60_000)
    : 0

  await closeDammPosition(positionId, reason)

  await sendAlert({
    type: 'pre_grad_closed',
    symbol,
    positionId,
    reason,
    ageMin,
  })

  console.log(`[PRE-GRAD] Exit closed ${positionId} reason: ${reason}`)
}

// ── monitor.ts compatibility shim ────────────────────────────────────────────

export async function closePreGradPosition(
  position: Record<string, unknown>
): Promise<boolean> {
  const positionId = String(position.id || position.position_id || '')
  if (!positionId) {
    console.error('[PRE-GRAD] closePreGradPosition called without id')
    return false
  }
  console.log(`[PRE-GRAD] closePreGradPosition called for ${positionId} (deferred to pre-grad loop)`)
  return false
}
