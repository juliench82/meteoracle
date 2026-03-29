/**
 * Executor — opens and closes Meteora DLMM positions
 * TODO: implement in feat/executor branch
 */
export async function openPosition(_strategyId: string, _tokenAddress: string): Promise<void> {
  // 1. Init Meteora DLMM SDK
  // 2. Find or create pool
  // 3. Build position config from strategy
  // 4. Call initializePositionAndAddLiquidityByStrategy
  // 5. Persist position to Supabase
  console.log('[executor] stub — implement in feat/executor')
}

export async function closePosition(_positionId: string): Promise<void> {
  // 1. Claim all rewards first
  // 2. Remove liquidity
  // 3. Update position in Supabase
  console.log('[executor] stub — implement in feat/executor')
}
