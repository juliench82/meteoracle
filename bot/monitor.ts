/**
 * Monitor — checks open positions for exit conditions
 * TODO: implement in feat/monitor branch
 */
export async function monitorPositions(): Promise<void> {
  // For each active position in Supabase:
  // 1. Fetch current bin from Meteora SDK
  // 2. Check if in range
  // 3. Check exit rules (OOR duration, stop loss, take profit, max duration)
  // 4. If exit triggered: call closePosition()
  // 5. Claim fees if threshold met
  console.log('[monitor] stub — implement in feat/monitor')
}
