/**
 * Scanner — polls DexScreener for new Solana tokens
 * TODO: implement in feat/scanner branch
 */
export async function scanCandidates(): Promise<void> {
  // 1. Fetch trending Solana tokens from DexScreener
  // 2. For each token, fetch holder data from Helius
  // 3. Fetch rugcheck score from rugcheck.xyz
  // 4. Run through getStrategyForToken()
  // 5. Persist passing candidates to Supabase
  console.log('[scanner] stub — implement in feat/scanner')
}
