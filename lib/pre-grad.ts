/**
 * lib/pre-grad.ts — DAMM v2 position lifecycle handler.
 *
 * Imported by bot/monitor.ts for `closePreGradPosition`.
 * Currently a stub — real DAMM exit logic will be added in the next iteration
 * once bot/damm-executor.ts is fully implemented.
 *
 * ISOLATION RULE: Must NOT import from bot/monitor.ts or bot/executor.ts.
 */

/**
 * Called by monitor.ts for any position with position_type === 'pre_grad'.
 * Returns true if the position was closed, false if skipped or not yet implemented.
 */
export async function closePreGradPosition(
  position: Record<string, unknown>
): Promise<boolean> {
  // TODO: Real DAMM v2 exit logic:
  // 1. Check exit conditions against strategy exits (stop-loss, take-profit, max duration, fee yield)
  // 2. Call closeDammPosition() from bot/damm-executor
  // 3. Update lp_positions row: status='closed', close_reason, fees_earned_sol, closed_at
  console.warn(
    `[pre-grad] closePreGradPosition stub — position ${position['id']} skipped. ` +
    `DAMM v2 executor not yet fully implemented.`
  )
  return false
}

/**
 * Explicit exit trigger — called externally when an exit condition is detected.
 * Will delegate to damm-executor once that layer is complete.
 */
export async function handleDammExit(
  positionId: string,
  reason: string
): Promise<void> {
  // TODO: Wire to closeDammPosition() in bot/damm-executor
  console.log(`[pre-grad] exit requested — positionId=${positionId}, reason=${reason}`)
}
