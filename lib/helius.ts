import axios from 'axios'

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!
const DAS_MAX_PAGES  = parseInt(process.env.HELIUS_HOLDER_MAX_PAGES ?? '1')

const HOLDER_CACHE_TTL_MS = 30 * 60 * 1_000
const _holderCache = new Map<string, { data: HolderData; ts: number }>()

export interface HolderData {
  holderCount:  number
  topHolderPct: number
  reliable:     boolean
}

// ── Rate limiter ───────────────────────────────────────────────────────────────
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

// Single limiter — DAS only now. 1/s vs Helius 2/s hard limit.
const dasLimiter = new RateLimiter(1)

// ── Public API ────────────────────────────────────────────────────────────────
// topHolderPct is always 0 — we removed the RPC calls that computed it.
// The scanner falls back to token.holders from Meteora pool data when reliable=false.
export async function checkHolders(mintAddress: string): Promise<HolderData> {
  const cached = _holderCache.get(mintAddress)
  if (cached && Date.now() - cached.ts < HOLDER_CACHE_TTL_MS) {
    console.log(`[helius] ${mintAddress} — cache hit (age=${Math.round((Date.now() - cached.ts) / 60_000)}min)`)
    return cached.data
  }

  const holderCount = await fetchDasHolderCount(mintAddress, 1_000, DAS_MAX_PAGES)

  let result: HolderData
  if (holderCount !== null) {
    console.log(`[helius] ${mintAddress} — ${holderCount} holders (DAS)`)
    result = { holderCount, topHolderPct: 0, reliable: true }
  } else {
    console.warn(`[helius] DAS failed for ${mintAddress}; caller should use Meteora token.holders`)
    result = { holderCount: 0, topHolderPct: 0, reliable: false }
  }

  if (result.reliable) _holderCache.set(mintAddress, { data: result, ts: Date.now() })
  return result
}

// ── Internals ─────────────────────────────────────────────────────────────────
async function fetchDasHolderCount(
  mint: string, pageSize: number, maxPages: number,
): Promise<number | null> {
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    let res
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await dasLimiter.acquire()   // blocks until we're under 1 req/s
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
    const accounts: unknown[] = (res?.data?.result?.token_accounts as unknown[]) ?? []
    total += accounts.length
    if (accounts.length < pageSize) break
    if (page === maxPages) console.warn(`[helius] ${mint} — hit max pages (${maxPages}), count is ${total}+`)
  }
  return total > 0 ? total : null
}
