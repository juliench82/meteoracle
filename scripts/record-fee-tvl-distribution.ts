/**
 * One-off recording script (NOT part of the test suite / CI).
 *
 * Records the LIVE distribution of `fee_tvl_ratio_24h` for the pools the
 * activity scanner actually selects, using the REAL code path
 * (fetchMeteoraPools -> applyJsPreFilter) with the scanner's own config, so the
 * sample is exactly the population the bot would open positions from.
 *
 * Writes raw JSON to the path given as argv[2] (outside the repo by default).
 * Anonymisation to a committed fixture happens in a separate step.
 */
import { writeFileSync } from 'node:fs'
import { fetchMeteoraPools } from '@/bot/scanner/pool-fetcher'
import { MIN_TVL_USD } from '@/lib/strategy-config'
import { ACTIVITY_MAX_POOL_AGE_MINUTES } from '@/lib/strategy-config'

const METEORA_FETCH_TIMEOUT_MS = 20_000

async function main() {
  const outPath = process.argv[2] ?? '/tmp/fee-tvl-recorded-raw.json'

  const { pools, error, rawCount } = await fetchMeteoraPools({
    minTvlUsd: MIN_TVL_USD,
    limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '50'),
    timeoutMs: METEORA_FETCH_TIMEOUT_MS,
    maxPoolAgeMinutes: ACTIVITY_MAX_POOL_AGE_MINUTES,
    minLiquidityUsd: 0,
    maxLiquidityUsd: Number.MAX_SAFE_INTEGER,
    strictFeeTvlRatioFilter: true,
    sortBy: 'fee_tvl_ratio_1h:desc',
  })

  const recorded = {
    recorded_at: new Date().toISOString(),
    endpoint: 'https://dlmm.datapi.meteora.ag/pools',
    query: {
      sort_by: 'fee_tvl_ratio_1h:desc',
      filter_by: `is_blacklisted=false && tvl>=500 && fee_24h>=5 && fee_tvl_ratio_24h>=0.005`,
      page_size: Math.min(parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '50'), 100),
    },
    error: error ?? null,
    rawCount: rawCount ?? null,
    selectedCount: pools.length,
    selected: pools.map((p) => ({
      address: p.address,
      name: p.name,
      tvl: p.tvl,
      created_at: p.created_at ?? p.pool_created_at ?? null,
      pool_config: p.pool_config,
      volume: p.volume ?? null,
      fees: p.fees ?? null,
      fee_tvl_ratio: p.fee_tvl_ratio ?? null,
      token_x: { address: p.token_x?.address, symbol: p.token_x?.symbol },
      token_y: { address: p.token_y?.address, symbol: p.token_y?.symbol },
    })),
  }

  writeFileSync(outPath, JSON.stringify(recorded, null, 2))
  console.log(`recorded ${pools.length} selected pools (rawCount=${rawCount ?? 'n/a'}) -> ${outPath}`)
  if (error) console.log(`fetch error: ${error}`)
}

main().catch((e) => {
  console.error('recording failed:', e)
  process.exit(1)
})