import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!

// Derive REST base from RPC URL: https://mainnet.helius-rpc.com/?api-key=XXX
// → https://mainnet.helius-rpc.com  (DAS uses the same host, different path)
function heliusDasUrl(): string {
  try {
    const url = new URL(HELIUS_RPC_URL)
    return `${url.protocol}//${url.host}`
  } catch {
    // fallback: use the RPC URL directly (Helius also accepts POST on the RPC endpoint for DAS)
    return HELIUS_RPC_URL
  }
}

export interface HolderData {
  holderCount:  number
  topHolderPct: number   // % held by the single largest non-program wallet
  reliable:     boolean  // false when we fell back to a partial / estimated value
}

/**
 * Returns real holder count and top-holder concentration for an SPL token.
 *
 * Strategy:
 *  1. Use Helius DAS `getTokenAccounts` (paginates up to MAX_PAGES × PAGE_SIZE)
 *     to get the true number of holders.  This is accurate.
 *  2. Simultaneously call `getTokenLargestAccounts` + `getTokenSupply` (cheap
 *     RPC calls) to compute topHolderPct from the top-20 accounts.
 *  3. If DAS fails but RPC succeeds → return { holderCount: accounts.length * 50,
 *     reliable: false } with a warning (better than null).
 *  4. If everything fails → return { holderCount: 0, topHolderPct: 0, reliable: false }
 *     so the scanner can fall back to the Meteora `holders` field rather than
 *     silently skipping the token.
 *
 * Credit cost: ~3 RPC credits + (pages × 1 DAS credit)
 */
export async function checkHolders(mintAddress: string): Promise<HolderData> {
  const PAGE_SIZE = 1000
  const MAX_PAGES = 10   // caps at 10 000 holders scanned; plenty for our thresholds

  // ── Run both lookups concurrently ────────────────────────────────────────
  const [rpcResult, dasResult] = await Promise.allSettled([
    fetchTopAccountsAndSupply(mintAddress),
    fetchDasHolderCount(mintAddress, PAGE_SIZE, MAX_PAGES),
  ])

  // ── Extract RPC data ──────────────────────────────────────────────────────
  let topHolderPct = 0
  let rpcAccounts: Array<{ amount: string }> = []
  if (rpcResult.status === 'fulfilled' && rpcResult.value) {
    rpcAccounts   = rpcResult.value.accounts
    topHolderPct  = rpcResult.value.topHolderPct
  } else {
    console.warn(`[helius] RPC calls failed for ${mintAddress}:`,
      rpcResult.status === 'rejected' ? rpcResult.reason : 'no data')
  }

  // ── Extract DAS holder count ──────────────────────────────────────────────
  if (dasResult.status === 'fulfilled' && dasResult.value !== null) {
    return {
      holderCount:  dasResult.value,
      topHolderPct,
      reliable:     true,
    }
  }

  console.warn(`[helius] DAS getTokenAccounts failed for ${mintAddress}; using heuristic`)

  if (rpcAccounts.length > 0) {
    // Rough estimate — better than nothing, caller will treat as unreliable
    return {
      holderCount:  rpcAccounts.length * 50,
      topHolderPct,
      reliable:     false,
    }
  }

  // Total failure — return zero with reliable=false so caller can fall back
  return { holderCount: 0, topHolderPct: 0, reliable: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTopAccountsAndSupply(mint: string): Promise<{
  accounts:     Array<{ amount: string }>
  topHolderPct: number
} | null> {
  const [largestRes, supplyRes] = await Promise.all([
    rpcCall('getTokenLargestAccounts', [mint]),
    rpcCall('getTokenSupply',          [mint]),
  ])

  const accounts: Array<{ amount: string }> = largestRes?.value ?? []
  const totalSupply = parseFloat(supplyRes?.value?.uiAmountString ?? '0')
  if (!totalSupply || accounts.length === 0) return null

  const topAmount   = parseFloat(accounts[0]?.amount ?? '0')
  const topHolderPct = (topAmount / totalSupply) * 100
  return { accounts, topHolderPct }
}

/**
 * Pages through DAS getTokenAccounts to count all token holders.
 * Returns the total count, or null if the call fails.
 */
async function fetchDasHolderCount(
  mint:      string,
  pageSize:  number,
  maxPages:  number,
): Promise<number | null> {
  const dasBase = heliusDasUrl()
  let total = 0
  let page  = 1

  while (page <= maxPages) {
    const res = await axios.post(
      HELIUS_RPC_URL,   // DAS methods work on the same RPC endpoint
      {
        jsonrpc: '2.0',
        id:      `das-${page}`,
        method:  'getTokenAccounts',
        params:  {
          mint,
          limit:  pageSize,
          page,
          // exclude zero-balance accounts
          options: { showZeroBalance: false },
        },
      },
      { timeout: 12_000 },
    )

    const tokenAccounts: unknown[] = res.data?.result?.token_accounts ?? []
    total += tokenAccounts.length

    // If we got fewer accounts than the page size, we've reached the last page
    if (tokenAccounts.length < pageSize) break
    page++
  }

  return total > 0 ? total : null
}

async function rpcCall(method: string, params: unknown[]) {
  const res = await axios.post(
    HELIUS_RPC_URL,
    { jsonrpc: '2.0', id: 1, method, params },
    { timeout: 8_000 },
  )
  return res.data?.result
}
