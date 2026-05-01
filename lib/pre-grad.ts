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
      // opened_at is the correct timestamp column in lp_positions
      const ageHours = (Date.now() - new Date(pos.opened_at).getTime()) / (1000 * 60 * 60)
      // pnl_sol is the actual column; derive pct from sol_deposited
      const pnlSol = Number(pos.pnl_sol ?? 0)
      const solDeposited = Number(pos.sol_deposited ?? 1)
      const pnlPct = solDeposited > 0 ? (pnlSol / solDeposited) * 100 : 0
      // fees_earned_sol is the actual column
      const feeYield = Number(pos.fees_earned_sol ?? 0)

      let reason = ''

      if (ageHours > 72) reason = 'max-duration'
      else if (pnlPct <= -30) reason = 'stop-loss'
      else if (pnlPct >= 40) reason = 'take-profit'
      else if (feeYield > 0.10) reason = 'fee-yield'

      if (reason) {
        const label = pos.symbol ?? pos.mint ?? pos.id
        console.log(`[PRE-GRAD] EXIT triggered: ${label} → ${reason}`)
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
