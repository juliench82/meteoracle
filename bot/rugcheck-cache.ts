/**
 * rugcheck-cache.ts
 * In-memory cache for Rugcheck scores with TTL + structured logging.
 * Prevents noise from the public endpoint returning inconsistent values.
 */

import { checkRugscore as _checkRugscore } from '@/lib/rugcheck'

const CACHE_TTL_MS = 8 * 60 * 1_000  // 8 minutes
const OUTLIER_DELTA = 25              // flag if new score deviates >25pts from cached

interface CacheEntry {
  score: number
  fetchedAt: number
}

const _cache = new Map<string, CacheEntry>()

export async function getRugscore(mint: string, symbol: string): Promise<number> {
  const now = Date.now()
  const cached = _cache.get(mint)

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[rugcheck] ${symbol} (${mint.slice(0, 8)}) — cache hit: ${cached.score} (age ${Math.round((now - cached.fetchedAt) / 1000)}s)`)
    return cached.score
  }

  let score: number
  try {
    score = await _checkRugscore(mint)
    console.log(`[rugcheck] ${symbol} (${mint.slice(0, 8)}) — fetched: ${score}`)
  } catch (err) {
    if (cached) {
      console.warn(`[rugcheck] ${symbol} fetch failed — using stale cache (${cached.score}):`, err)
      return cached.score
    }
    console.warn(`[rugcheck] ${symbol} fetch failed — no cache, returning 0:`, err)
    return 0
  }

  if (cached && Math.abs(score - cached.score) > OUTLIER_DELTA) {
    console.warn(
      `[rugcheck] ${symbol} outlier detected — new=${score} cached=${cached.score} delta=${Math.abs(score - cached.score)} ` +
      `(threshold=${OUTLIER_DELTA}) — using cached value`
    )
    // Update cache timestamp but keep old score to avoid noise
    _cache.set(mint, { score: cached.score, fetchedAt: now })
    return cached.score
  }

  _cache.set(mint, { score, fetchedAt: now })
  return score
}

export function getRugcheckCacheSize(): number {
  return _cache.size
}
