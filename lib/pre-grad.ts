/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Manages the monitoring loop and exit routing for positions opened via the
 * DAMM edge track (strategy_id = 'damm-edge').
 *
 * ISOLATION RULE: Must NOT import from bot/monitor.ts or bot/executor.ts.
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Monitor loop ──────────────────────────────────────────────────────────────────

/**
 * Start the DAMM position monitor.
 * Called once at bot startup (alongside startMonitor in bot/monitor.ts).
 *
 * Next iteration TODOs:
 *   1. Query lp_positions WHERE strategy_id = 'damm-edge' AND status = 'active'.
 *   2. For each position, evaluate exit rules:
 *      - Stop-loss (SOL value < entry * stopLossPct)
 *      - Take-profit (SOL value > entry * takeProfitPct)
 *      - Fee yield exit (feesEarnedSol / solDeposited > feeYieldExitPct)
 *      - Max duration (age > maxDurationHours)
 *   3. Call handleDammExit() for any position that triggers a rule.
 */
export async function startPreGradMonitor(): Promise<void> {
  console.log('[PRE-GRAD] Starting DAMM position monitor...')

  setInterval(async () => {
    console.log('[PRE-GRAD] Checking DAMM positions...')

    // TODO: Query active damm-edge positions
    // const { data, error } = await supabase
    //   .from('lp_positions')
    //   .select('*')
    //   .eq('strategy_id', 'damm-edge')
    //   .eq('status', 'active')
    //
    // TODO: Iterate + evaluate exit rules per position
    // if (error) console.error('[PRE-GRAD] DB error:', error.message)
  }, 60_000)
}

// ── Exit handler ─────────────────────────────────────────────────────────────────

/**
 * Explicit exit trigger. Called by startPreGradMonitor (above) or externally
 * when an exit condition fires.
 *
 * TODO: Wire to closeDammPosition() in bot/damm-executor once fully implemented.
 */
export async function handleDammExit(
  positionId: string,
  reason: string
): Promise<void> {
  // TODO: import { closeDammPosition } from '../bot/damm-executor'
  // TODO: await closeDammPosition(positionId, reason)
  // TODO: await supabase.from('lp_positions')
  //         .update({ status: 'closed', close_reason: reason, closed_at: new Date().toISOString() })
  //         .eq('id', positionId)
  console.log(`[PRE-GRAD] Exit requested for ${positionId} reason: ${reason}`)
}

// ── monitor.ts compatibility shim ─────────────────────────────────────────────────

/**
 * Called by bot/monitor.ts for any position with position_type === 'pre_grad'.
 * Returns true if the position was closed, false if skipped.
 *
 * TODO: Replace stub with real DAMM v2 exit logic:
 *   1. Evaluate exit rules against the position
 *   2. Call handleDammExit() if triggered
 *   3. Return true only when the position was actually closed
 */
export async function closePreGradPosition(
  position: Record<string, unknown>
): Promise<boolean> {
  console.warn(
    `[PRE-GRAD] closePreGradPosition stub — position ${position['id']} skipped. ` +
    `DAMM v2 executor not yet fully implemented.`
  )
  return false
}
