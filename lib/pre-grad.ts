/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Manages the monitoring loop and exit routing for positions opened via the
 * DAMM edge track (strategy_id = 'damm-edge').
 *
 * ISOLATION RULE: Must NOT import anything from bot/monitor.ts or bot/executor.ts.
 */

import { closeDammPosition } from '../bot/damm-executor'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Monitor loop ──────────────────────────────────────────────────────────────────

/**
 * Start the DAMM position monitor (60s interval).
 * Called once at bot startup.
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
      const ageHours = (Date.now() - new Date(pos.created_at).getTime()) / (1000 * 60 * 60)
      const pnlPct = pos.pnl_pct || 0
      const feeYield = pos.fee_yield_sol || 0

      let reason = ''

      if (ageHours > 72) reason = 'max-duration'
      else if (pnlPct <= -30) reason = 'stop-loss'
      else if (pnlPct >= 40) reason = 'take-profit'
      else if (feeYield > 0.10) reason = 'fee-yield'

      if (reason) {
        console.log(`[PRE-GRAD] EXIT triggered: ${pos.token_symbol || pos.token_address} → ${reason}`)
        await handleDammExit(pos.id, reason)
      }
    }
  }, 60_000)
}

// ── Exit handler ───────────────────────────────────────────────────────────────

/**
 * Explicit exit trigger. Called by startPreGradMonitor or externally
 * when an exit condition fires.
 */
export async function handleDammExit(
  positionId: string,
  reason: string
): Promise<void> {
  await closeDammPosition(positionId, reason)
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
