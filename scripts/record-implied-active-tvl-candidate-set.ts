/**
 * One-off recording script (NOT part of the test suite / CI).
 *
 * Records the LIVE candidate set for the activity scanner — the FULL set of
 * pools the server-side list call returns (before the client-side JS
 * pre-filter), with each pool flagged as selected/rejected — using the REAL
 * code path (`fetchMeteoraPools` + the module's own in-process cache via
 * `getCachedMeteoraPools`), so the sample is exactly the population the bot
 * filters and the "selected" flag is exactly the bot's own decision.
 *
 * Why the full set (not just survivors): audit finding M6 is about pools being
 * WRONGLY REJECTED by the implied-active-TVL gate, so the previously-rejected
 * pools must be in the fixture to assert AC-B8.3.
 *
 * Writes raw JSON to the path given as argv[2] (outside the repo). Anonymisation
 * to a committed fixture happens in a separate step.
 */
import { writeFileSync } from 'node:fs'
import { fetchMeteoraPools, getCachedMeteoraPools } from '@/bot/scanner/pool-fetcher'
import { MIN_TVL_USD, ACTIVITY_MAX_POOL_AGE_MINUTES } from '@/lib/strategy-config'

const METEORA_FETCH_TIMEOUT_MS = 20_000

function snapshot(p: any, selected: boolean) {
  return {
    address: p.address,
    name: p.name,
    tvl: p.tvl,
    created_at: p.created_at ?? p.pool_created_at ?? null,
    pool_config: p.pool_config ?? null,
    volume: p.volume ?? null,
    fees: p.fees ?? null,
    fee_tvl_ratio: p.fee_tvl_ratio ?? null,
    token_x: { address: p.token_x?.address, symbol: p.token_x?.symbol },
    token_y: { address: p.token_y?.address, symbol: p.token_y?.symbol },
    is_blacklisted: p.is_blacklisted ?? null,
    selected,
  }
}

async function main() {
  const outPath = process.argv[2] ?? '/tmp/implied-active-tvl-recorded-raw.json'

  const { pools: selectedPools, error, rawCount } = await fetchMeteoraPools({
    minTvlUsd: MIN_TVL_USD,
    limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '50'),
    timeoutMs: METEORA_FETCH_TIMEOUT_MS,
    maxPoolAgeMinutes: ACTIVITY_MAX_POOL_AGE_MINUTES,
    minLiquidityUsd: 0,
    maxLiquidityUsd: Number.MAX_SAFE_INTEGER,
    strictFeeTvlRatioFilter: true,
    sortBy: 'fee_tvl_ratio_1h:desc',
  })

  const raw = getCachedMeteoraPools() ?? []
  const selectedAddrs = new Set(selectedPools.map((p) => p.address))

  const recorded = {
    recorded_at: new Date().toISOString(),
    endpoint: 'https://dlmm.datapi.meteora.ag/pools',
    query: {
      sort_by: 'fee_tvl_ratio_1h:desc',
      filter_by: 'is_blacklisted=false && tvl>=500 && fee_24h>=5 && fee_tvl_ratio_24h>=0.005',
      page_size: Math.min(parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '50'), 100),
    },
    error: error ?? null,
    rawCount: rawCount ?? null,
    selectedCount: selectedPools.length,
    rawPoolCount: raw.length,
    pools: raw.map((p: any) => snapshot(p, selectedAddrs.has(p.address))),
  }

  writeFileSync(outPath, JSON.stringify(recorded, null, 2))
  console.log(
    `recorded ${raw.length} candidate pools (rawCount=${rawCount ?? 'n/a'}) of which ${selectedPools.length} selected -> ${outPath}`,
  )
  if (error) console.log(`fetch error: ${error}`)
}

main().catch((e) => {
  console.error('recording failed:', e)
  process.exit(1)
})