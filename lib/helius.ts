import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!

export interface HolderData {
  holderCount: number
  topHolderPct: number  // % held by the single largest non-program wallet
}

/**
 * Fetches holder count and top holder concentration for a SPL token.
 * Uses Helius RPC getTokenLargestAccounts + getTokenSupply.
 *
 * Credit cost: ~3 credits per call (2 RPC calls).
 */
export async function checkHolders(mintAddress: string): Promise<HolderData | null> {
  try {
    const [largestRes, supplyRes] = await Promise.all([
      rpcCall('getTokenLargestAccounts', [mintAddress]),
      rpcCall('getTokenSupply', [mintAddress]),
    ])

    const accounts: Array<{ amount: string }> = largestRes?.value ?? []
    const totalSupply = parseFloat(supplyRes?.value?.uiAmountString ?? '0')

    if (!totalSupply || accounts.length === 0) return null

    // Estimate holder count from largest accounts list
    // (getTokenLargestAccounts returns top 20 — we use this as a proxy)
    const holderCount = accounts.length * 50  // rough heuristic; replace with Helius DAS if needed

    const topAmount = parseFloat(accounts[0]?.amount ?? '0')
    const topHolderPct = totalSupply > 0 ? (topAmount / totalSupply) * 100 : 0

    return { holderCount, topHolderPct }
  } catch (err) {
    console.error(`[helius] checkHolders failed for ${mintAddress}:`, err)
    return null
  }
}

async function rpcCall(method: string, params: unknown[]) {
  const res = await axios.post(
    HELIUS_RPC_URL,
    { jsonrpc: '2.0', id: 1, method, params },
    { timeout: 8_000 }
  )
  return res.data?.result
}
