/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Manages the monitoring loop and exit routing for positions opened via the
 * DAMM edge track (strategy_id = 'damm-edge').
 *
 * ISOLATION RULE: Must NOT import anything from bot/monitor.ts or bot/executor.ts.
 *
 * SOURCE OF TRUTH RULE: Meteora API is the source of truth for all money fields.
 * We never compute PnL locally. We store snapshots from Meteora at close time.
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

// ── DAMM v2 REST: per-position live fields ────────────────────────────────────

/**
 * Fetches both claimable fees (USD) and current position value (USD) for a
 * specific position pubkey from Meteora's REST API.
 *
 * Meteora is the source of truth for both numbers — no local computation.
 *
 * Endpoint: GET https://amm-v2.meteora.ag/position/{position_pubkey}
 * Fields:
 *   fee_pending_usd    — claimable fees, mirrors Meteora UI
 *   position_value_usd — current value of token amounts at current price
 *
 * Returns null on any failure — non-blocking.
 */
async function fetchMeteoraPosFields(positionPubkey: string): Promise<{
  claimableFeesUsd: number | null
  positionValueUsd: number | null
} | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/position/${positionPubkey}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()

    const claimableFeesUsd =
      data.fee_pending_usd ?? data.total_fee_usd ?? data.claimable_fee_usd ?? null

    const positionValueUsd =
      data.position_value_usd ?? data.total_value_usd ?? data.value_usd ?? null

    return {
      claimableFeesUsd: claimableFeesUsd !== null ? Number(claimableFeesUsd) : null,
      positionValueUsd: positionValueUsd !== null ? Number(positionValueUsd) : null,
    }
  } catch {
    return null
  }
}

// ── On-chain state fetch ──────────────────────────────────────────────────────

/**
 * Reads current sqrtPrice from DAMM pool state.
 * Used only for exit signal evaluation (stop-loss / take-profit price thresholds).
 * NOT used for PnL display — Meteora REST is the source of truth for that.
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
    const [onChain, poolStats, meteoraPos] = await Promise.all([
      fetchDammPositionState(pos.pool_address),
      fetchDammPoolStats(pos.pool_address),
      fetchMeteoraPosFields(pos.position_pubkey),
    ])

    const claimableFeesUsd = meteoraPos?.claimableFeesUsd ?? null
    const positionValueUsd = meteoraPos?.positionValueUsd ?? null

    // ── Metadata update: store Meteora-sourced USD fields ────────────────────
    // We always update metadata when we have new data, regardless of exit.
    // pnl_sol and il_pct are intentionally NOT written — Meteora is source of truth.
    if (onChain) {
      await supabase
        .from('lp_positions')
        .update({
          current_price: onChain.currentPriceSol,
          metadata: {
            ...(pos.metadata ?? {}),
            // Live USD fields from Meteora — what the UI should display
            ...(claimableFeesUsd !== null && { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 }),
            ...(positionValueUsd !== null && { position_value_usd: Math.round(positionValueUsd * 100) / 100 }),
            // Pool-level context
            ...(poolStats && {
              volume_24h_usd:   Math.round(poolStats.volume24hUsd),
              tvl_usd:          Math.round(poolStats.tvlUsd),
              stats_updated_at: new Date().toISOString(),
            }),
          },
        })
        .eq('id', pos.id)
    } else {
      console.warn(`[PRE-GRAD] RPC miss for ${pos.id} — skipping TP/SL this tick`)
    }

    // ── Exit triggers — price-based signals use on-chain price ratio ─────────
    // We use the on-chain price ratio for signal precision (not USD display).
    let reason = ''
    if (ageHours > 72) {
      reason = 'max-duration'
    } else if (onChain && Number(pos.entry_price_sol ?? 0) > 0) {
      const entryPrice = Number(pos.entry_price_sol)
      const pricePct = ((onChain.currentPriceSol - entryPrice) / entryPrice) * 100
      if (pricePct <= -30) reason = 'stop-loss'
      else if (pricePct >= 40) reason = 'take-profit'
    }

    if (reason) {
      const label = pos.symbol ?? pos.mint ?? pos.id
      const feesDisplay = claimableFeesUsd !== null ? `$${claimableFeesUsd.toFixed(2)}` : 'n/a'
      const valueDisplay = positionValueUsd !== null ? `$${positionValueUsd.toFixed(2)}` : 'n/a'
      console.log(`[PRE-GRAD] EXIT: ${label} → ${reason} (value=${valueDisplay} claimable=${feesDisplay})`)
      await handleDammExit(pos.id, reason, pos.symbol ?? pos.mint ?? 'UNKNOWN', pos.opened_at, claimableFeesUsd, positionValueUsd)
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
  claimableFeesUsd?: number | null,
  positionValueUsd?: number | null,
): Promise<void> {
  const ageMin = openedAt
    ? Math.round((Date.now() - new Date(openedAt).getTime()) / 60_000)
    : 0

  // closeDammPosition writes status='closed' to DB and returns the authoritative
  // post-zap USD values from the Meteora PnL API (4× retry). Use those values in
  // the alert; fall back to the pre-close snapshot only if the API returned null.
  const closeResult = await closeDammPosition(positionId, reason)

  const alertClaimableFeesUsd = closeResult.totalFeeEarnedUsd ?? claimableFeesUsd ?? undefined
  const alertPositionValueUsd = positionValueUsd ?? undefined
  const alertRealizedPnlUsd   = closeResult.realizedPnlUsd ?? undefined

  await sendAlert({
    type: 'pre_grad_closed',
    symbol,
    positionId,
    reason,
    ageMin,
    ...(alertClaimableFeesUsd != null && { claimableFeesUsd: alertClaimableFeesUsd }),
    ...(alertPositionValueUsd != null && { positionValueUsd: alertPositionValueUsd }),
    ...(alertRealizedPnlUsd   != null && { realizedPnlUsd:   alertRealizedPnlUsd   }),
  })

  console.log(`[PRE-GRAD] Exit closed ${positionId} reason: ${reason}`)
}
