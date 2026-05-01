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

// ── On-chain state fetch ─────────────────────────────────────────────────────────

/**
 * Reads current sqrtPrice from DAMM pool state and derives a SOL-denominated
 * price. Also reads unclaimed fees from the position account.
 *
 * sqrtPrice in DAMM v2 is a Q64.64 fixed-point number:
 *   price = (sqrtPrice / 2^64)^2
 * We only need a ratio vs entry_price_sol for PnL %, so units cancel out.
 *
 * Returns null if the RPC call fails so the caller can skip the tick safely.
 */
async function fetchDammPositionState(
  poolAddress: string,
  positionPubkey: string,
): Promise<{ currentPriceSol: number; feesEarnedSol: number } | null> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js')
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')

    const connection = new Connection(process.env.RPC_URL!, 'confirmed')
    const sdk = new CpAmm(connection)

    const poolState = await sdk.fetchPoolState(new PublicKey(poolAddress))
    if (!poolState) return null

    // sqrtPrice is Q64.64: price = (sqrtPrice / 2^64)^2
    const TWO_POW_64 = 2n ** 64n
    const sqrtPriceBig = BigInt(poolState.sqrtPrice.toString())
    const currentPriceSol = Number((sqrtPriceBig * sqrtPriceBig) / (TWO_POW_64 * TWO_POW_64))

    // Fetch unclaimed fees from the position account
    let feesEarnedSol = 0
    try {
      const positionState = await sdk.fetchPositionState(new PublicKey(positionPubkey))
      if (positionState) {
        const feeA = Number(positionState.feeOwed?.feeAOwed ?? 0) / 1e9
        const feeB = Number(positionState.feeOwed?.feeBOwed ?? 0) / 1e9
        feesEarnedSol = feeA + feeB
      }
    } catch {
      // fees are non-critical — carry on with 0
    }

    return { currentPriceSol, feesEarnedSol }
  } catch (err) {
    console.error('[PRE-GRAD] fetchDammPositionState failed:', err)
    return null
  }
}

// ── Monitor loop ──────────────────────────────────────────────────────────────────

/**
 * Start the DAMM position monitor (60s interval).
 * Called once at bot startup from app/api/bot/tick/route.ts.
 */
export async function startPreGradMonitor(): Promise<void> {
  console.log('[PRE-GRAD] Starting DAMM position monitor (60s interval)...')

  setInterval(async () => {
    console.log('[PRE-GRAD] Checking active DAMM positions...')

    const { data: positions, error } = await supabase
      .from('lp_positions')
      .select('*')
      .eq('strategy_id', 'damm-edge')
      .eq('status', 'active')

    if (error) {
      console.error('[PRE-GRAD] DB query error:', error.message)
      return
    }

    if (!positions || positions.length === 0) {
      console.log('[PRE-GRAD] No active DAMM positions')
      return
    }

    console.log(`[PRE-GRAD] Evaluating ${positions.length} DAMM position(s)`)

    for (const pos of positions) {
      const ageHours = (Date.now() - new Date(pos.opened_at).getTime()) / (1000 * 60 * 60)
      const solDeposited = Number(pos.sol_deposited ?? 1)

      // Fetch live on-chain state
      const onChain = await fetchDammPositionState(pos.pool_address, pos.position_pubkey)

      let pnlSol: number
      let feesEarnedSol: number
      let pnlPct: number

      if (onChain && onChain.currentPriceSol > 0 && Number(pos.entry_price_sol ?? 0) > 0) {
        const entryPrice = Number(pos.entry_price_sol)
        const pricePct = ((onChain.currentPriceSol - entryPrice) / entryPrice) * 100
        // Standard CPAMM IL approximation: 2√k/(1+k) − 1
        const k = onChain.currentPriceSol / entryPrice
        const ilPct = (2 * Math.sqrt(k) / (1 + k) - 1) * 100
        feesEarnedSol = onChain.feesEarnedSol
        pnlSol = solDeposited * (pricePct / 100) + feesEarnedSol
        pnlPct = solDeposited > 0 ? (pnlSol / solDeposited) * 100 : 0

        // Write live metrics back to DB so dashboard + exit logic are accurate
        await supabase
          .from('lp_positions')
          .update({
            current_price: onChain.currentPriceSol,
            fees_earned_sol: feesEarnedSol,
            pnl_sol: Math.round(pnlSol * 1e6) / 1e6,
            il_pct: Math.round(ilPct * 100) / 100,
          })
          .eq('id', pos.id)
      } else {
        // RPC miss or no entry price — fall back to DB values, skip TP/SL
        pnlSol = Number(pos.pnl_sol ?? 0)
        feesEarnedSol = Number(pos.fees_earned_sol ?? 0)
        pnlPct = solDeposited > 0 ? (pnlSol / solDeposited) * 100 : 0
        if (!onChain) {
          console.warn(`[PRE-GRAD] RPC miss for ${pos.id} — skipping TP/SL this tick`)
        }
      }

      let reason = ''

      if (ageHours > 72) reason = 'max-duration'
      else if (onChain && pnlPct <= -30) reason = 'stop-loss'
      else if (onChain && pnlPct >= 40) reason = 'take-profit'
      else if (feesEarnedSol > 0.10) reason = 'fee-yield'

      if (reason) {
        const label = pos.symbol ?? pos.mint ?? pos.id
        console.log(`[PRE-GRAD] EXIT triggered: ${label} → ${reason} (pnl=${pnlPct.toFixed(1)}% fees=${feesEarnedSol.toFixed(4)} SOL)`)
        await handleDammExit(pos.id, reason, pos.symbol ?? pos.mint ?? 'UNKNOWN', pos.opened_at)
      }
    }
  }, 60_000)
}

// ── Exit handler ───────────────────────────────────────────────────────────────

/**
 * Explicit exit trigger. Called by startPreGradMonitor or externally
 * when an exit condition fires. Fires pre_grad_closed Telegram alert.
 */
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

// ── monitor.ts compatibility shim ─────────────────────────────────────────────

/**
 * Called by bot/monitor.ts for any position with strategy_id === 'damm-edge'.
 * Returns true if the position was closed, false if skipped.
 * Exit ownership belongs to startPreGradMonitor; this shim defers accordingly.
 */
export async function closePreGradPosition(
  position: Record<string, unknown>
): Promise<boolean> {
  const positionId = String(position.id || position.position_id || '')
  if (!positionId) {
    console.error('[PRE-GRAD] closePreGradPosition called without id')
    return false
  }

  console.log(`[PRE-GRAD] closePreGradPosition called for ${positionId} (monitor compatibility — deferred to pre-grad loop)`)
  return false
}
