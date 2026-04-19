import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!

// Full pagination: fetch all pages until exhausted.
// Each page = 1000 accounts. Cap at 3 pages (3k holders) to avoid runaway calls.
// Override with HELIUS_HOLDER_MAX_PAGES env var.
const DAS_MAX_PAGES = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '3')

// In-memory cache: avoid re-fetching holder data for repeat survivors within 30min
const HOLDER_CACHE_TTL_MS = 30 * 60 * 1_000
const _holderCache = new Map<string, { data: HolderData; ts: number }>()

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
  const cached = _holderCache.get(mintAddress)
  if (cached && Date.now() - cached.ts < HOLDER_CACHE_TTL_MS) {
    console.log(`[helius] ${mintAddress} — holder data from cache (age=${Math.round((Date.now() - cached.ts) / 60_000)}min)`)
    return cached.data
  }

  const PAGE_SIZE = 1000

  // Sequential: DAS first (most expensive), then RPC — avoids simultaneous burst
  const dasResult = await fetchDasHolderCount(mintAddress, PAGE_SIZE, DAS_MAX_PAGES).then(
    v => ({ status: 'fulfilled' as const, value: v }),
    e => ({ status: 'rejected' as const, reason: e }),
  )
  const rpcResult = await fetchTopAccountsAndSupply(mintAddress).then(
    v => ({ status: 'fulfilled' as const, value: v }),
    e => ({ status: 'rejected' as const, reason: e }),
  )

  let topHolderPct = 0
  let rpcAccounts: Array<{ uiAmount: number | null }> = []
  if (rpcResult.status === 'fulfilled' && rpcResult.value) {
    rpcAccounts  = rpcResult.value.accounts
    topHolderPct = rpcResult.value.topHolderPct
  } else {
    console.warn(`[helius] RPC calls failed for ${mintAddress}:`,
      rpcResult.status === 'rejected' ? rpcResult.reason : 'no data')
  }

  let result: HolderData

  if (dasResult.status === 'fulfilled' && dasResult.value !== null) {
    const holderCount = dasResult.value
    console.log(`[helius] ${mintAddress} — ${holderCount} holders (fully paginated)`)
    result = { holderCount, topHolderPct, reliable: true }
  } else {
    console.warn(`[helius] DAS failed for ${mintAddress}; using heuristic`)
    if (rpcAccounts.length > 0) {
      result = { holderCount: rpcAccounts.length * 50, topHolderPct, reliable: false }
    } else {
      result = { holderCount: 0, topHolderPct: 0, reliable: false }
    }
  }

  // Only cache reliable results — don't cache 0-holder fallbacks
  if (result.reliable) {
    _holderCache.set(mintAddress, { data: result, ts: Date.now() })
  }

  return result
}

async function fetchTopAccountsAndSupply(mint: string): Promise<{
  accounts:     Array<{ uiAmount: number | null }>
  topHolderPct: number
} | null> {
  const [largestRes, supplyRes] = await Promise.all([
    rpcCall('getTokenLargestAccounts', [mint], 5),
    rpcCall('getTokenSupply',          [mint], 5),
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
    let res
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await axios.post(
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
        break
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 429 && attempt < 4) {
          const delay = 1_000 * 2 ** attempt + Math.random() * 500
          console.warn(`[helius] 429 on getTokenAccounts page ${page}, retry ${attempt + 1} in ${Math.round(delay)}ms`)
          await new Promise(r => setTimeout(r, delay))
        } else {
          throw err
        }
      }
    }

    const tokenAccounts: unknown[] = res?.data?.result?.token_accounts ?? []
    total += tokenAccounts.length

    if (tokenAccounts.length < pageSize) break
    page++
  }

  if (page > maxPages) {
    console.warn(`[helius] ${mint} — hit max pages (${maxPages}), holder count is ${total}+`)
  }

  return total > 0 ? total : null
}

async function rpcCall(method: string, params: unknown[], retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        HELIUS_RPC_URL,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 8_000 },
      )
      return res.data?.result
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429 && i < retries - 1) {
        const delay = 1_000 * 2 ** i + Math.random() * 500
        console.warn(`[helius] 429 on ${method}, retry ${i + 1} in ${Math.round(delay)}ms`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw err
      }
    }
  }
}
