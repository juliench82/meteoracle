import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!
const DAS_MAX_PAGES  = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '1')

const HOLDER_CACHE_TTL_MS = 60 * 60 * 1_000
const _holderCache = new Map<string, { data: HolderData; ts: number }>()

export interface HolderData {
  holderCount:  number
  topHolderPct: number
  reliable:     boolean
}

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Conservative vs Helius hard limits: DAS=2/s → we use 1/s; RPC=10/s → we use 8/s
class RateLimiter {
  private window: number[] = []
  constructor(private maxPerSecond: number) {}

  async acquire(): Promise<void> {
    const now = Date.now()
    this.window = this.window.filter(t => now - t < 1_000)
    if (this.window.length >= this.maxPerSecond) {
      const wait = 1_000 - (now - this.window[0]) + 60
      await new Promise(r => setTimeout(r, wait))
      return this.acquire()
    }
    this.window.push(Date.now())
  }
}

const dasLimiter = new RateLimiter(1)   // 1/s (Helius DAS limit: 2/s)
const rpcLimiter = new RateLimiter(8)   // 8/s (Helius RPC limit: 10/s)

// ── Public API ────────────────────────────────────────────────────────────────
export async function checkHolders(mintAddress: string): Promise<HolderData> {
  const cached = _holderCache.get(mintAddress)
  if (cached && Date.now() - cached.ts < HOLDER_CACHE_TTL_MS) {
    console.log(`[helius] ${mintAddress} — cache hit (age=${Math.round((Date.now() - cached.ts) / 60_000)}min)`)
    return cached.data
  }

  const [dasResult, rpcResult] = await Promise.allSettled([
    fetchDasHolderCount(mintAddress, 1_000, DAS_MAX_PAGES),
    fetchTopAccountsAndSupply(mintAddress),
  ])

  let topHolderPct = 0
  let rpcAccounts: Array<{ uiAmount: number | null }> = []
  if (rpcResult.status === 'fulfilled' && rpcResult.value) {
    rpcAccounts  = rpcResult.value.accounts
    topHolderPct = rpcResult.value.topHolderPct
  }

  let result: HolderData
  if (dasResult.status === 'fulfilled' && dasResult.value !== null) {
    console.log(`[helius] ${mintAddress} — ${dasResult.value} holders (DAS), topHolder=${topHolderPct.toFixed(1)}%`)
    result = { holderCount: dasResult.value, topHolderPct, reliable: true }
  } else {
    console.warn(`[helius] DAS failed for ${mintAddress}; using heuristic`)
    result = rpcAccounts.length > 0
      ? { holderCount: rpcAccounts.length * 50, topHolderPct, reliable: false }
      : { holderCount: 0, topHolderPct: 0, reliable: false }
  }

  if (result.reliable) _holderCache.set(mintAddress, { data: result, ts: Date.now() })
  return result
}

// ── Internals ─────────────────────────────────────────────────────────────────
async function fetchTopAccountsAndSupply(mint: string): Promise<{
  accounts:     Array<{ uiAmount: number | null }>
  topHolderPct: number
} | null> {
  // Sequential — not Promise.all — to avoid saturating Helius burst window
  const largestRes = await rpcCall('getTokenLargestAccounts', [mint])
  const supplyRes  = await rpcCall('getTokenSupply',          [mint])

  const accounts: Array<{ uiAmount: number | null }> = (largestRes as { value?: Array<{ uiAmount: number | null }> })?.value ?? []
  const totalSupply = parseFloat(
    (supplyRes as { value?: { uiAmountString?: string } })?.value?.uiAmountString ?? '0',
  )
  if (!totalSupply || accounts.length === 0) return null

  const topHolderPct = ((accounts[0]?.uiAmount ?? 0) / totalSupply) * 100
  return { accounts, topHolderPct }
}

async function fetchDasHolderCount(
  mint: string, pageSize: number, maxPages: number,
): Promise<number | null> {
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    let res
    for (let attempt = 0; attempt < 6; attempt++) {
      await dasLimiter.acquire()
      try {
        res = await axios.post(
          HELIUS_RPC_URL,
          {
            jsonrpc: '2.0', id: `das-${page}`, method: 'getTokenAccounts',
            params: { mint, limit: pageSize, page, options: { showZeroBalance: false } },
          },
          { timeout: 12_000 },
        )
        break
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 429) {
          const delay = 2_000 * 2 ** attempt + Math.random() * 1_000
          console.warn(`[helius] 429 on getTokenAccounts page ${page}, retry ${attempt + 1} in ${Math.round(delay)}ms`)
          await new Promise(r => setTimeout(r, delay))
        } else {
          throw err
        }
      }
    }
    if (!res) {
      console.warn(`[helius] ${mint} — getTokenAccounts exhausted retries, returning null`)
      return null
    }
    const accounts: unknown[] = (res?.data?.result?.token_accounts as unknown[]) ?? []
    total += accounts.length
    if (accounts.length < pageSize) break
    if (page === maxPages) console.warn(`[helius] ${mint} — hit max pages (${maxPages}), count is ${total}+`)
  }
  return total > 0 ? total : null
}

async function rpcCall(method: string, params: unknown[], retries = 5): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    await rpcLimiter.acquire()
    try {
      const res = await axios.post(
        HELIUS_RPC_URL,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 8_000 },
      )
      return res.data?.result
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) {
        const delay = 1_500 * 2 ** i + Math.random() * 500
        console.warn(`[helius] 429 on ${method}, retry ${i + 1} in ${Math.round(delay)}ms`)
        await new Promise(r => setTimeout(r, delay))
        // intentionally no throw — continue loop
      } else {
        throw err
      }
    }
  }
  console.warn(`[helius] ${method} exhausted ${retries} retries, returning null`)
  return null
}
