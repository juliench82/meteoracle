// Startup validation — light non-fatal checks to catch misconfig before capital at risk.
// Does not throw on failure (logs + returns false); heavy calls are best-effort.
import { getConnection, getWallet } from './solana'
import { LP_FEE_TVL_EXIT_THRESHOLD, MIN_FEE_TVL_RATIO_24H } from './strategy-config'

export async function validateStartup(label = 'worker'): Promise<boolean> {
  const logPfx = `[startup][${label}]`
  let ok = true
  try {
    const conn = getConnection()
    const wallet = getWallet()
    console.log(`${logPfx} wallet=${wallet.publicKey.toBase58().slice(0,8)}`)

    // Basic RPC reachability
    try {
      const bh = await conn.getLatestBlockhash('finalized')
      console.log(`${logPfx} RPC reachable (blockhash ok)`)
    } catch (e) {
      console.warn(`${logPfx} RPC check failed:`, e instanceof Error ? e.message : e)
      ok = false
    }

    // Wallet has enough SOL to operate (rough > 0.2 reserve for fees + 1 position)
    try {
      const bal = await conn.getBalance(wallet.publicKey)
      const sol = bal / 1e9
      const minReserve = 0.25
      if (sol < minReserve) {
        console.warn(`${logPfx} LOW WALLET BALANCE: ${sol.toFixed(3)} SOL (want >~${minReserve}) — may fail fee or position sizing`)
        ok = false
      } else {
        console.log(`${logPfx} wallet balance ~${sol.toFixed(3)} SOL (ok)`)
      }
    } catch (e) {
      console.warn(`${logPfx} balance check failed (non-fatal):`, e instanceof Error ? e.message : e)
    }

    // Jupiter public endpoint warning (can cause stranded sells under load)
    if (!process.env.JUPITER_QUOTE_API_URL) {
      console.warn(`${logPfx} JUPITER_QUOTE_API_URL not set — using public endpoint (rate limits may cause stranded sells on close cascades). Consider a private Jupiter RPC.`)
    }

    // Fee/TVL exit vs entry sanity: exit threshold must be *below* entry to avoid open→close churn on fresh positions.
    const entryPct = MIN_FEE_TVL_RATIO_24H * 100
    if (LP_FEE_TVL_EXIT_THRESHOLD >= entryPct) {
      console.warn(`${logPfx} !!! CONFIG WARNING: LP_FEE_TVL_EXIT_THRESHOLD (${LP_FEE_TVL_EXIT_THRESHOLD}%) >= MIN_FEE_TVL_RATIO_24H*100 (${entryPct}%) — this mismatch causes immediate open→close churn and fee burn. Set e.g. LP_FEE_TVL_EXIT_THRESHOLD=0.3`)
      ok = false
    } else {
      console.log(`${logPfx} fee/tvl exit ${LP_FEE_TVL_EXIT_THRESHOLD}% < entry ${entryPct}% (ok)`)
    }
  } catch (e) {
    console.warn(`${logPfx} startup validation error (continuing):`, e instanceof Error ? e.message : e)
    ok = false
  }
  return ok
}
