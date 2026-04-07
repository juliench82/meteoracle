import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!

// Full pagination: fetch all pages until exhausted.
// Each page = 1000 accounts. Cap at 20 pages (20k holders) to avoid runaway calls.
// Override with HELIUS_HOLDER_MAX_PAGES env var.
const DAS_MAX_PAGES = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '20')

function heliusDasUrl(): string {
  try {
    const url = new URL(HELIUS_RPC_URL)
    return `${url.protocol}//${url.host}`
  } catch {
    return HELIUS_RPC_URL
  }
}

export interface HolderData {
  holderCount:  number
  topHolderPct: number
  reliable:     boolean
}

export async function checkHolders(mintAddress: string): Promise<HolderData> {
  const PAGE_SIZE = 1000

  const [rpcResult, dasResult] = await Promise.allSettled([
    fetchTopAccountsAndSupply(mintAddress),
    fetchDasHolderCount(mintAddress, PAGE_SIZE, DAS_MAX_PAGES),
  ])

  let topHolderPct = 0
  let rpcAccounts: Array<{ uiAmount: number | null }> = []
  if (rpcResult.status === 'fulfilled' && rpcResult.value) {
    rpcAccounts  = rpcResult.value.accounts
    topHolderPct = rpcResult.value.topHolderPct
  } else {
    console.warn(`[helius] RPC calls failed for ${mintAddress}:`,
      rpcResult.status === 'rejected' ? rpcResult.reason : 'no data')
  }

  if (dasResult.status === 'fulfilled' && dasResult.value !== null) {
    const holderCount = dasResult.value
    console.log(`[helius] ${mintAddress} — ${holderCount} holders (fully paginated)`)
    return { holderCount, topHolderPct, reliable: true }
  }

  console.warn(`[helius] DAS failed for ${mintAddress}; using heuristic`)

  if (rpcAccounts.length > 0) {
    return { holderCount: rpcAccounts.length * 50, topHolderPct, reliable: false }
  }

  return { holderCount: 0, topHolderPct: 0, reliable: false }
}

async function fetchTopAccountsAndSupply(mint: string): Promise<{
  accounts:     Array<{ uiAmount: number | null }>
  topHolderPct: number
} | null> {
  const [largestRes, supplyRes] = await Promise.all([
    rpcCall('getTokenLargestAccounts', [mint]),
    rpcCall('getTokenSupply',          [mint]),
  ])

  const accounts: Array<{ uiAmount: number | null }> = largestRes?.value ?? []
  const totalSupply = parseFloat(supplyRes?.value?.uiAmountString ?? '0')
  if (!totalSupply || accounts.length === 0) return null

  const topAmount    = accounts[0]?.uiAmount ?? 0
  const topHolderPct = (topAmount / totalSupply) * 100
  return { accounts, topHolderPct }
}

async function fetchDasHolderCount(
  mint:     string,
  pageSize: number,
  maxPages: number,
): Promise<number | null> {
  let total = 0
  let page  = 1

  while (page <= maxPages) {
    const res = await axios.post(
      HELIUS_RPC_URL,
      {
        jsonrpc: '2.0',
        id:      `das-${page}`,
        method:  'getTokenAccounts',
        params:  {
          mint,
          limit:   pageSize,
          page,
          options: { showZeroBalance: false },
        },
      },
      { timeout: 12_000 },
    )

    const tokenAccounts: unknown[] = res.data?.result?.token_accounts ?? []
    total += tokenAccounts.length

    // If we got fewer than a full page, we've reached the end
    if (tokenAccounts.length < pageSize) break
    page++
  }

  if (page > maxPages) {
    console.warn(`[helius] ${mint} — hit max pages (${maxPages}), holder count is ${total}+`)
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
