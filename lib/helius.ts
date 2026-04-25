import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!
const DAS_MAX_PAGES  = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '1') // default 1 page = 1000 holders

const HOLDER_CACHE_TTL_MS = 30 * 60 * 1_000 // 30 min
const _holderCache = new Map<string, { data: HolderData; ts: number }>()

export interface HolderData {
  holderCount:  number
  topHolderPct: number
  reliable:     boolean
}

// ── Global serial gate ────────────────────────────────────────────────────────
// All Helius calls (DAS + RPC) share ONE queue. This prevents the burst where
// 3 concurrent calls per token × N queued tokens = instant 429 storm.
// Min spacing: 400ms → max ~2.5 req/s, safely under the 3 req/s shared limit.
const MIN_CALL_SPACING_MS = 400
let _lastCallTs = 0

async function acquireGlobalSlot(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, _lastCallTs + MIN_CALL_SPACING_MS - now)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _lastCallTs = Date.now()
}

// ── Inflight dedup ────────────────────────────────────────────────────────────
// Prevents the same mint from stacking duplicate in-flight calls while
// waiting in the retry queue.
const _inflight = new Map<string, Promise<HolderData>>()

export async function checkHolders(mintAddress: string): Promise<HolderData> {
  const existing = _inflight.get(mintAddress)
  if (existing) {
    console.log(`[helius] ${mintAddress} — deduped (already in-flight)`)
    return existing
  }

  const p = _checkHoldersInner(mintAddress).finally(() => _inflight.delete(mintAddress))
  _inflight.set(mintAddress, p)
  return p
}

async function _checkHoldersInner(mintAddress: string): Promise<HolderData> {
  // Must explicitly opt-in: HELIUS_ENABLED=true
  if (process.env.HELIUS_ENABLED !== 'true') {
    return { holderCount: 0, topHolderPct: 0, reliable: false }
  }

  const cached = _holderCache.get(mintAddress)
  if (cached && Date.now() - cached.ts < HOLDER_CACHE_TTL_MS) {
    console.log(`[helius] ${mintAddress} — cache hit (age=${Math.round((Date.now() - cached.ts) / 60_000)}min)`)
    return cached.data
  }

  // 1. DAS — sequential, globally gated
  let holderCount: number | null = null
  if (DAS_MAX_PAGES > 0) {
    holderCount = await fetchDasHolderCount(mintAddress, 1_000, DAS_MAX_PAGES).catch(() => null)
  }

  // 2. RPC — sequential after DAS, same global gate
  const rpcResult = await fetchTopAccountsAndSupply(mintAddress).catch(() => null)

  const topHolderPct = rpcResult?.topHolderPct ?? 0
  const rpcAccounts  = rpcResult?.accounts ?? []

  let result: HolderData
  if (holderCount !== null) {
    console.log(`[helius] ${mintAddress} — ${holderCount} holders (DAS), topHolder=${topHolderPct.toFixed(1)}%`)
    result = { holderCount, topHolderPct, reliable: true }
  } else {
    const estimated = rpcAccounts.length > 0 ? rpcAccounts.length * 50 : 0
    console.warn(`[helius] ${mintAddress} — DAS failed; ~${estimated} holders (heuristic), topHolder=${topHolderPct.toFixed(1)}%`)
    result = { holderCount: estimated, topHolderPct, reliable: false }
  }

  if (result.reliable) _holderCache.set(mintAddress, { data: result, ts: Date.now() })
  return result
}

// ── Internals ─────────────────────────────────────────────────────────────────
async function fetchTopAccountsAndSupply(mint: string): Promise<{
  accounts:     Array<{ uiAmount: number | null }>
  topHolderPct: number
} | null> {
  // Sequential — each awaits the global gate individually
  const largestRes = await rpcCall('getTokenLargestAccounts', [mint])
  const supplyRes  = await rpcCall('getTokenSupply',          [mint])

  const accounts: Array<{ uiAmount: number | null }> =
    (largestRes as { value?: Array<{ uiAmount: number | null }> })?.value ?? []
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
    // 3 retries max — at 8s max backoff (~14s total ceiling).
    // Data is stale after 64s anyway; fail fast and use heuristic.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await acquireGlobalSlot()
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
          const delay = Math.min(500 * 2 ** attempt + Math.random() * 400, 8_000)
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
    if (page === maxPages) {
      console.warn(`[helius] ${mint} — hit max pages (${maxPages}), count is ${total}+`)
    }
  }
  return total > 0 ? total : null
}

async function rpcCall(method: string, params: unknown[], retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    await acquireGlobalSlot()
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
        const delay = Math.min(500 * 2 ** i + Math.random() * 400, 8_000)
        console.warn(`[helius] 429 on ${method}, retry ${i + 1} in ${Math.round(delay)}ms`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw err
      }
    }
  }
  console.warn(`[helius] ${method} exhausted ${retries} retries, returning null`)
  return null
}
