import { getHeliusRpcEndpoint } from '@/lib/solana'
import {
  getHeliusMaxAttempts,
  heliusAxiosPost,
  isRpcProviderCooldownError,
} from '@/lib/rpc-rate-limit'

const DAS_MAX_PAGES  = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '1') // default 1 page = 1000 holders

const DAS_CACHE_TTL_MS       = 8 * 60 * 1_000  // 8 min — reliable DAS result
const HEURISTIC_CACHE_TTL_MS = 4 * 60 * 1_000  // 4 min — heuristic fallback

const _holderCache = new Map<string, { data: HolderData; ts: number; reliable: boolean }>()

export function getHolderCacheSize(): number {
  return _holderCache.size
}

export interface HolderData {
  holderCount:  number
  topHolderPct: number
  reliable:     boolean
}

type JsonRpcResponse<T> = {
  result?: T
}

// ── Inflight dedup ────────────────────────────────────────────────────────────
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
  if (process.env.HELIUS_ENABLED !== 'true') {
    return { holderCount: 0, topHolderPct: 0, reliable: false }
  }
  const heliusRpcUrl = getHeliusRpcEndpoint()
  if (!heliusRpcUrl) {
    console.warn('[helius] HELIUS_ENABLED=true but HELIUS_API_KEY is missing')
    return { holderCount: 0, topHolderPct: 0, reliable: false }
  }

  const cached = _holderCache.get(mintAddress)
  if (cached) {
    const ttl = cached.reliable ? DAS_CACHE_TTL_MS : HEURISTIC_CACHE_TTL_MS
    if (Date.now() - cached.ts < ttl) {
      console.log(`[helius] ${mintAddress} — cache hit (${cached.reliable ? 'reliable' : 'heuristic'}, age=${Math.round((Date.now() - cached.ts) / 60_000)}min)`)
      return cached.data
    }
  }

  // 1. DAS — sequential, globally gated
  let holderCount: number | null = null
  if (DAS_MAX_PAGES > 0) {
    holderCount = await fetchDasHolderCount(heliusRpcUrl, mintAddress, 1_000, DAS_MAX_PAGES).catch(() => null)
  }

  // 2. RPC — sequential after DAS, same global gate
  const rpcResult = await fetchTopAccountsAndSupply(heliusRpcUrl, mintAddress).catch(() => null)

  const topHolderPct = rpcResult?.topHolderPct ?? 0
  const rpcAccounts  = rpcResult?.accounts ?? []

  let result: HolderData
  if (holderCount !== null) {
    console.log(`[helius] ${mintAddress} — ${holderCount} holders (DAS), topHolder=${topHolderPct.toFixed(1)}%`)
    result = { holderCount, topHolderPct, reliable: true }
  } else {
    // RPC getTokenLargestAccounts returns at most 20 accounts.
    // Use the top-holder concentration as a proxy: if top holder is X% of supply,
    // a rough lower-bound estimate is 100/X * 3 (assumes top holder ~3× avg concentration).
    // Floor at 500, cap at 50_000 to avoid absurd values.
    const topPct = rpcResult?.topHolderPct ?? 0
    let estimated: number
    if (topPct > 0) {
      estimated = Math.min(Math.max(Math.round((100 / topPct) * 3), 500), 50_000)
    } else {
      // No RPC data at all — use 0 so score_holders reflects unknown, not fake 1000
      estimated = 0
    }
    console.warn(`[helius] ${mintAddress} — DAS failed, using heuristic (est ~${estimated} holders, topHolder=${topPct.toFixed(1)}%)`)
    result = { holderCount: estimated, topHolderPct: topPct, reliable: false }
  }

  _holderCache.set(mintAddress, { data: result, ts: Date.now(), reliable: result.reliable })
  return result
}

// ── Internals ─────────────────────────────────────────────────────────────────
async function fetchTopAccountsAndSupply(heliusRpcUrl: string, mint: string): Promise<{
  accounts:     Array<{ uiAmount: number | null }>
  topHolderPct: number
} | null> {
  const largestRes = await rpcCall(heliusRpcUrl, 'getTokenLargestAccounts', [mint])
  const supplyRes  = await rpcCall(heliusRpcUrl, 'getTokenSupply',          [mint])

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
  heliusRpcUrl: string,
  mint: string, pageSize: number, maxPages: number,
): Promise<number | null> {
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    let res
    const attempts = getHeliusMaxAttempts()
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        res = await heliusAxiosPost<JsonRpcResponse<{ token_accounts?: unknown[] }>>(
          heliusRpcUrl,
          {
            jsonrpc: '2.0', id: `das-${page}`, method: 'getTokenAccounts',
            params: { mint, limit: pageSize, page, options: { showZeroBalance: false } },
          },
          { timeout: 12_000 },
        )
        break
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (isRpcProviderCooldownError(err)) {
          console.warn(`[helius] getTokenAccounts page ${page} skipped during cooldown`)
          return null
        }
        if (status === 429) {
          console.warn(`[helius] 429 on getTokenAccounts page ${page}; provider cooldown recorded`)
          return null
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
      console.log(`[helius] ${mint} — hit max pages (${maxPages}), count is ${total}+`)
    }
  }
  return total > 0 ? total : null
}

async function rpcCall(heliusRpcUrl: string, method: string, params: unknown[], attempts = getHeliusMaxAttempts()): Promise<unknown> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await heliusAxiosPost<JsonRpcResponse<unknown>>(
        heliusRpcUrl,
        { jsonrpc: '2.0', id: 1, method, params },
        { timeout: 8_000 },
        method,
      )
      return res.data?.result
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (isRpcProviderCooldownError(err)) {
        console.warn(`[helius] ${method} skipped during cooldown`)
        return null
      }
      if (status === 429) {
        console.warn(`[helius] 429 on ${method}; provider cooldown recorded`)
        return null
      } else {
        throw err
      }
    }
  }
  console.warn(`[helius] ${method} exhausted ${attempts} attempt(s), returning null`)
  return null
}
