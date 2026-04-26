import axios from 'axios'

/**
 * Fetches a rugcheck.xyz risk score for a Solana token.
 *
 * Meteoracle score = 100 - score_normalised
 *   rugcheck   0/100 (safe)    → Meteoracle 100
 *   rugcheck  34/100 (warning) → Meteoracle  66
 *   rugcheck  58/100 (warning) → Meteoracle  42
 *   rugcheck 100/100 (rugged)  → Meteoracle   0
 *
 * The public endpoint allows ~3 req/s. No API key needed.
 * Cache: 10 min for real scores, 2 min for error fallbacks.
 * Rate floor: at least 350 ms between outbound requests.
 */

const CACHE_TTL_MS       = 10 * 60 * 1_000   // 10 minutes for successful hits
const ERROR_CACHE_TTL_MS =  2 * 60 * 1_000   // 2 minutes for fallback values
const MIN_REQUEST_GAP_MS = 350               // max ~2.8 req/s — safely under the 3/s limit

const _cache = new Map<string, { score: number; ts: number; isError: boolean }>()
let _lastRequestAt = 0

async function rateLimitedFetch(mintAddress: string): Promise<{ raw?: number; normalised?: number } | null> {
  const now   = Date.now()
  const wait  = MIN_REQUEST_GAP_MS - (now - _lastRequestAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  _lastRequestAt = Date.now()

  const res = await axios.get(
    `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
    { timeout: 8_000 },
  )
  return res.data ?? null
}

export async function checkRugscore(mintAddress: string): Promise<number> {
  const now    = Date.now()
  const cached = _cache.get(mintAddress)

  if (cached) {
    const ttl = cached.isError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS
    if (now - cached.ts < ttl) {
      console.debug(`[rugcheck] ${mintAddress} — cache hit (age=${Math.round((now - cached.ts) / 1000)}s, score=${cached.score})`)
      return cached.score
    }
  }

  try {
    const data       = await rateLimitedFetch(mintAddress)
    const raw        = data?.score
    const normalised = data?.score_normalised
    console.log(`[rugcheck] ${mintAddress} raw: ${raw}, normalised: ${normalised}`)

    let score: number

    if (typeof normalised === 'number') {
      score = Math.min(100, Math.max(0, 100 - normalised))
    } else if (typeof raw === 'number') {
      score = raw > 10_000 ? 0 : Math.round(Math.max(0, 100 - (raw / 100)))
    } else {
      console.warn(`[rugcheck] ${mintAddress} — unexpected response shape, defaulting to 70`)
      score = 70
      _cache.set(mintAddress, { score, ts: now, isError: true })
      return score
    }

    _cache.set(mintAddress, { score, ts: now, isError: false })
    return score

  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 429) {
      console.warn(`[rugcheck] ${mintAddress} — rate limited (429), defaulting to 70`)
    } else {
      console.warn(`[rugcheck] ${mintAddress} — fetch failed, defaulting to 70`)
    }
    const score = 70
    _cache.set(mintAddress, { score, ts: now, isError: true })
    return score
  }
}

export function getRugcheckCacheSize(): number {
  return _cache.size
}
