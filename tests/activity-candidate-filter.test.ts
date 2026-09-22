/**
 * Hermetic tests for the activity candidate filter / best-pool selection
 * (bot/scanner/activity-candidate-filter.ts).
 *
 * NOTE (transitive imports): this module transitively imports pool-fetcher ->
 * pool-metrics -> lib/solana (the @solana/web3.js SDK chain). Imports are
 * side-effect free and the suite stays hermetic (no network, no env, no RPC).
 */
import { describe, expect, it } from 'vitest'
import {
  candidateTokenAddress,
  selectBestPool,
  selectTopCandidates,
} from '@/bot/scanner/activity-candidate-filter'
import { WSOL, type MeteoraPool } from '@/bot/scanner/pool-fetcher'

type Poolish = Record<string, any>

/** Minimal valid MeteoraPool fixture: SOL-paired, tradable side = `mint`. */
function makePool(address: string, mint: string, feeTvlRatio24h: number, tvl = 1000): MeteoraPool {
  return {
    address,
    name: `${mint.slice(0, 4)}-SOL`,
    created_at: Date.now() / 1000 - 3600 * 10, // 10h old
    tvl,
    current_price: 0.001,
    pool_config: { bin_step: 100, base_fee_pct: 0.01 },
    token_x: { address: WSOL, symbol: 'WSOL', decimals: 9, holders: 0, market_cap: 0, price: 1 },
    token_y: {
      address: mint,
      symbol: mint.slice(0, 4).toUpperCase(),
      decimals: 6,
      holders: 100,
      market_cap: 1000,
      price: 0.001,
    },
    fee_tvl_ratio: { '24h': feeTvlRatio24h },
    is_blacklisted: false,
  } as unknown as MeteoraPool
}

describe('selectTopCandidates', () => {
  it('AC6: dedupes pools that share one tradable mint to exactly one candidate', () => {
    const pools = [
      makePool('pool-a1', 'mint-alpha', 0.04),
      makePool('pool-a2', 'mint-alpha', 0.06), // same mint, second tier
      makePool('pool-b1', 'mint-beta', 0.03),
    ]
    const candidates = selectTopCandidates(pools, new Set())
    expect(candidates.length).toBe(2)
    const mints = candidates.map((c) => candidateTokenAddress(c)).sort()
    expect(mints).toEqual(['mint-alpha', 'mint-beta'])
  })

  it('AC6: skips mints that were recently closed OOR', () => {
    const pools = [
      makePool('pool-a1', 'mint-alpha', 0.04),
      makePool('pool-b1', 'mint-beta', 0.03),
    ]
    const candidates = selectTopCandidates(pools, new Set(['mint-beta']))
    expect(candidates.length).toBe(1)
    expect(candidateTokenAddress(candidates[0])).toBe('mint-alpha')
  })

  it('AC6: caps the list at maxCandidates', () => {
    const pools = Array.from({ length: 6 }, (_, i) => makePool(`pool-${i}`, `mint-${i}`, 0.02))
    const candidates = selectTopCandidates(pools, new Set(), { maxCandidates: 2 })
    expect(candidates.length).toBe(2)
  })

  it('candidateTokenAddress works on raw pools and ActivityCandidate wrappers', () => {
    const pool = makePool('pool-x', 'mint-x', 0.02)
    expect(candidateTokenAddress(pool)).toBe('mint-x')
    expect(candidateTokenAddress({ pool, ageHours: 3 })).toBe('mint-x')
    expect(candidateTokenAddress({})).toBe('')
    expect(candidateTokenAddress(null)).toBe('')
  })
})

describe('selectBestPool', () => {
  it('picks the highest 24h Fee/TVL among same-token tiers', () => {
    const tierLow = makePool('pool-tier-1', 'mint-tier', 0.03)
    const tierHigh = makePool('pool-tier-2', 'mint-tier', 0.06)
    const result = selectBestPool([tierLow, tierHigh], 'mint-tier')
    expect(result.pool).not.toBeNull()
    expect(result.pool!.address).toBe('pool-tier-2')
  })

  it('returns the single matching pool when there is only one tier', () => {
    const pool = makePool('pool-solo', 'mint-solo', 0.05)
    const result = selectBestPool([pool], 'mint-solo')
    expect(result.pool?.address).toBe('pool-solo')
  })

  it('returns null when the token is absent from the provided list (no unrelated fallback)', () => {
    const pool = makePool('pool-other', 'mint-other', 0.05)
    const result = selectBestPool([pool], 'mint-missing')
    expect(result.pool).toBeNull()
  })

  it('normalizes ActivityCandidate wrappers and returns a raw pool', () => {
    const pool = makePool('pool-wrap', 'mint-wrap', 0.07)
    const result = selectBestPool([{ pool, ageHours: 1 }], 'mint-wrap')
    expect(result.pool?.address).toBe('pool-wrap')
  })
})