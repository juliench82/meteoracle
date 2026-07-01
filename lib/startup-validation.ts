// Startup validation — light non-fatal checks to catch misconfig before capital at risk.
// Does not throw on failure (logs + returns false); heavy calls are best-effort.
import { getConnection, getWallet } from './solana'

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
  } catch (e) {
    console.warn(`${logPfx} startup validation error (continuing):`, e instanceof Error ? e.message : e)
    ok = false
  }
  return ok
}
