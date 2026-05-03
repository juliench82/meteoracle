import 'dotenv/config'

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import bs58 from 'bs58'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  MigrationOption,
  deriveDammV2PoolAddress,
  type PoolConfig,
  type VirtualPool,
  type VirtualPoolMetadata,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { getRpcEndpointCandidates } from '@/lib/solana'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { openDammPosition } from './damm-executor'

const DBC_PROGRAM_ID = new PublicKey(
  process.env.DBC_PROGRAM_ID ?? DYNAMIC_BONDING_CURVE_PROGRAM_ID.toString(),
)
const WATCH_INTERVAL_MS = parseInt(process.env.DBC_GRADUATION_WATCH_INTERVAL_SEC ?? '10', 10) * 1_000
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DBC_DISCOVERY_INTERVAL_SEC ?? '60', 10) * 1_000
const WATCH_MIN_PROGRESS_PCT = parseFloat(process.env.DBC_WATCH_MIN_PROGRESS_PCT ?? '90')
const OPEN_PROGRESS_PCT = parseFloat(process.env.DBC_OPEN_PROGRESS_PCT ?? '100')
const DBC_MIN_SCORE_TO_OPEN = parseFloat(process.env.DBC_MIN_SCORE_TO_OPEN ?? '55')
const DBC_MIN_MIGRATION_QUOTE_SOL = parseFloat(process.env.DBC_MIN_MIGRATION_QUOTE_SOL ?? '5')
const DAMM_MIGRATION_SOL_PER_POSITION = parseFloat(process.env.DAMM_MIGRATION_SOL_PER_POSITION ?? '0.55')
const AUTO_TRIGGER_MIGRATION = process.env.DBC_AUTO_TRIGGER_MIGRATION !== 'false'
const USE_PROGRAM_SUBSCRIPTION = process.env.DBC_USE_PROGRAM_SUBSCRIPTION !== 'false'
const DISCOVERY_POLL_ENABLED = process.env.DBC_DISCOVERY_POLL_ENABLED !== 'false'
const DISCOVERY_MAX_POOLS = parseInt(process.env.DBC_DISCOVERY_MAX_POOLS ?? '1000', 10)
const DAMM_POOL_WAIT_ATTEMPTS = parseInt(process.env.DBC_DAMM_POOL_WAIT_ATTEMPTS ?? '12', 10)
const DAMM_POOL_WAIT_MS = parseInt(process.env.DBC_DAMM_POOL_WAIT_MS ?? '2500', 10)
const WATCHLIST_SOURCE = 'meteora-dbc'

type WatchlistRow = {
  id: string
  mint: string
  symbol: string | null
  status: string
  opened_position_id: string | null
  metadata: Record<string, unknown> | null
}

type DbcPoolContext = {
  virtualPoolAddress: PublicKey
  virtualPool: VirtualPool
  poolConfig: PoolConfig
  metadata: VirtualPoolMetadata | null
  progressPct: number
  dammConfig: PublicKey
  dammPool: PublicKey
  symbol: string
}

type DbcMigrationScore = {
  score: number
  passed: boolean
  reason: string
  rejectReason?: string
  quoteReserveSol: number
  migrationThresholdSol: number
  breakdown: Record<string, number>
}

let connection: Connection | null = null
let dbcClient: DynamicBondingCurveClient | null = null
let cpAmm: any = null
let lastDiscoveryAt = 0
const inFlightPools = new Set<string>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRpcUrl(): string {
  const url = getRpcEndpointCandidates()[0]
  if (!url) throw new Error('[dbc-graduation] RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
  return url
}

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(getRpcUrl(), 'confirmed')
  }
  return connection
}

function getDbcClient(): DynamicBondingCurveClient {
  if (!dbcClient) {
    dbcClient = DynamicBondingCurveClient.create(getConnection(), 'confirmed')
  }
  return dbcClient
}

async function getCpAmm(): Promise<any> {
  if (!cpAmm) {
    const mod = await import('@meteora-ag/cp-amm-sdk')
    cpAmm = new mod.CpAmm(getConnection())
  }
  return cpAmm
}

function getWallet(): Keypair {
  const key = process.env.WALLET_PRIVATE_KEY
  if (!key) throw new Error('[dbc-graduation] WALLET_PRIVATE_KEY not set')
  try {
    if (key.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)))
    }
    return Keypair.fromSecretKey(bs58.decode(key))
  } catch {
    throw new Error('[dbc-graduation] WALLET_PRIVATE_KEY is invalid - must be base58 or JSON uint8 array')
  }
}

async function getBotDryRun(): Promise<boolean> {
  const state = await getBotState()
  return process.env.BOT_DRY_RUN === 'true' || state.dry_run
}

function toBigIntAmount(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string') return BigInt(value)
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    return BigInt((value as { toString: () => string }).toString())
  }
  return 0n
}

function getProgressPct(virtualPool: VirtualPool, poolConfig: PoolConfig): number {
  const reserve = toBigIntAmount(virtualPool.quoteReserve)
  const threshold = toBigIntAmount(poolConfig.migrationQuoteThreshold)
  if (threshold <= 0n) return 0
  const scaled = (reserve * 1_000_000n) / threshold
  return Math.min(100, Number(scaled) / 10_000)
}

function solFromLamports(value: unknown): number {
  return Number(toBigIntAmount(value)) / 1_000_000_000
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isMigrated(virtualPool: VirtualPool): boolean {
  return Number(virtualPool.isMigrated ?? 0) !== 0
}

function getDammConfig(poolConfig: PoolConfig): PublicKey | null {
  const configured = process.env.DAMM_MIGRATION_CONFIG_ADDRESS ?? process.env.DAMM_CONFIG_ADDRESS
  if (configured) return new PublicKey(configured)

  const migrationFeeOption = Number(poolConfig.migrationFeeOption)
  const mapped = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]
  return mapped ? new PublicKey(mapped) : null
}

function getSymbol(metadata: VirtualPoolMetadata | null, mint: PublicKey): string {
  const name = metadata?.name?.trim()
  if (name) return name.slice(0, 24)
  return `DBC-${mint.toBase58().slice(0, 6)}`
}

function evaluateDbcMigrationCandidate(ctx: DbcPoolContext): DbcMigrationScore {
  const quoteMint = ctx.poolConfig.quoteMint.toBase58()
  const quoteReserveSol = solFromLamports(ctx.virtualPool.quoteReserve)
  const migrationThresholdSol = solFromLamports(ctx.poolConfig.migrationQuoteThreshold)
  const breakdown: Record<string, number> = {}

  if (quoteMint !== NATIVE_MINT.toBase58()) {
    return {
      score: 0,
      passed: false,
      reason: 'quote mint is not WSOL',
      rejectReason: 'quote_not_wsol',
      quoteReserveSol,
      migrationThresholdSol,
      breakdown,
    }
  }

  if (migrationThresholdSol < DBC_MIN_MIGRATION_QUOTE_SOL) {
    return {
      score: 0,
      passed: false,
      reason: `migration quote threshold ${migrationThresholdSol.toFixed(2)} SOL < ${DBC_MIN_MIGRATION_QUOTE_SOL} SOL`,
      rejectReason: 'migration_threshold_too_small',
      quoteReserveSol,
      migrationThresholdSol,
      breakdown,
    }
  }

  const progressRange = Math.max(1, OPEN_PROGRESS_PCT - WATCH_MIN_PROGRESS_PCT)
  breakdown.progress = Math.round(clamp((ctx.progressPct - WATCH_MIN_PROGRESS_PCT) / progressRange, 0, 1) * 35)
  breakdown.quoteReserve =
    quoteReserveSol >= 50 ? 25 :
    quoteReserveSol >= 25 ? 20 :
    quoteReserveSol >= 10 ? 15 :
    quoteReserveSol >= 5  ? 8  : 0
  breakdown.migrationThreshold =
    migrationThresholdSol >= 50 ? 15 :
    migrationThresholdSol >= 25 ? 12 :
    migrationThresholdSol >= 10 ? 8  :
    migrationThresholdSol >= 5  ? 4  : 0
  breakdown.readiness =
    isMigrated(ctx.virtualPool) || ctx.progressPct >= OPEN_PROGRESS_PCT ? 15 :
    ctx.progressPct >= 95 ? 8 : 0
  breakdown.metadata =
    (ctx.metadata?.name?.trim() ? 5 : 0) +
    (ctx.metadata?.website?.trim() ? 2 : 0) +
    (ctx.metadata?.logo?.trim() ? 3 : 0)
  breakdown.dammConfig = 10

  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  const passed = score >= DBC_MIN_SCORE_TO_OPEN
  return {
    score,
    passed,
    reason: passed
      ? `score ${score} >= ${DBC_MIN_SCORE_TO_OPEN}`
      : `score ${score} < ${DBC_MIN_SCORE_TO_OPEN}`,
    rejectReason: passed ? undefined : 'score_below_threshold',
    quoteReserveSol,
    migrationThresholdSol,
    breakdown,
  }
}

async function getPoolMetadata(client: DynamicBondingCurveClient, virtualPoolAddress: PublicKey): Promise<VirtualPoolMetadata | null> {
  try {
    const rows = await client.state.getPoolMetadata(virtualPoolAddress)
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function loadPoolContext(virtualPoolAddress: PublicKey, knownPool?: VirtualPool): Promise<DbcPoolContext | null> {
  const client = getDbcClient()
  const virtualPool = knownPool ?? await client.state.getPool(virtualPoolAddress)
  if (!virtualPool) return null

  const poolConfig = await client.state.getPoolConfig(virtualPool.config)
  if (Number(poolConfig.migrationOption) !== MigrationOption.MET_DAMM_V2) return null

  const dammConfig = getDammConfig(poolConfig)
  if (!dammConfig) {
    console.warn(`[dbc-graduation] ${virtualPoolAddress.toBase58()} skipped: no DAMM v2 migration config for fee option ${poolConfig.migrationFeeOption}`)
    return null
  }

  const metadata = await getPoolMetadata(client, virtualPoolAddress)
  const dammPool = deriveDammV2PoolAddress(dammConfig, virtualPool.baseMint, poolConfig.quoteMint)
  const progressPct = getProgressPct(virtualPool, poolConfig)

  return {
    virtualPoolAddress,
    virtualPool,
    poolConfig,
    metadata,
    progressPct,
    dammConfig,
    dammPool,
    symbol: getSymbol(metadata, virtualPool.baseMint),
  }
}

async function findWatchlistRow(mint: string): Promise<WatchlistRow | null> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('pre_grad_watchlist')
    .select('id, mint, symbol, status, opened_position_id, metadata')
    .eq('mint', mint)
    .order('detected_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn(`[dbc-graduation] watchlist lookup failed for ${mint}: ${error.message}`)
    return null
  }
  return data as WatchlistRow | null
}

async function upsertWatchlist(ctx: DbcPoolContext, status: string, extraMetadata: Record<string, unknown> = {}): Promise<WatchlistRow | null> {
  const supabase = createServerClient()
  const mint = ctx.virtualPool.baseMint.toBase58()
  const existing = await findWatchlistRow(mint)
  const metadata = {
    ...(existing?.metadata ?? {}),
    ...extraMetadata,
    virtual_pool: ctx.virtualPoolAddress.toBase58(),
    damm_pool: ctx.dammPool.toBase58(),
    damm_config: ctx.dammConfig.toBase58(),
    pool_config: ctx.virtualPool.config.toBase58(),
    quote_mint: ctx.poolConfig.quoteMint.toBase58(),
    quote_reserve: ctx.virtualPool.quoteReserve.toString(),
    migration_quote_threshold: ctx.poolConfig.migrationQuoteThreshold.toString(),
    is_migrated: isMigrated(ctx.virtualPool),
    updated_by: 'dbc-graduation-watcher',
  }
  const payload = {
    mint,
    symbol: ctx.symbol,
    launchpad_source: WATCHLIST_SOURCE,
    bonding_curve_pct: Math.round(ctx.progressPct * 100) / 100,
    status,
    last_seen_at: new Date().toISOString(),
    metadata,
  }

  if (existing) {
    const { data, error } = await supabase
      .from('pre_grad_watchlist')
      .update(payload)
      .eq('id', existing.id)
      .select('id, mint, symbol, status, opened_position_id, metadata')
      .single()
    if (error) {
      console.warn(`[dbc-graduation] watchlist update failed for ${mint}: ${error.message}`)
      return existing
    }
    return data as WatchlistRow
  }

  const { data, error } = await supabase
    .from('pre_grad_watchlist')
    .insert({ ...payload, detected_at: new Date().toISOString() })
    .select('id, mint, symbol, status, opened_position_id, metadata')
    .single()
  if (error) {
    console.warn(`[dbc-graduation] watchlist insert failed for ${mint}: ${error.message}`)
    return null
  }
  return data as WatchlistRow
}

async function updateWatchlistById(id: string, values: Record<string, unknown>): Promise<void> {
  const supabase = createServerClient()
  const { error } = await supabase
    .from('pre_grad_watchlist')
    .update(values)
    .eq('id', id)
  if (error) console.warn(`[dbc-graduation] watchlist update failed for ${id}: ${error.message}`)
}

async function hasOpenPositionForMint(mint: string): Promise<boolean> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .select('id')
    .eq('mint', mint)
    .in('status', OPEN_LP_STATUSES)
    .limit(1)

  if (error) {
    console.warn(`[dbc-graduation] open-position dedup failed for ${mint}: ${error.message}`)
    return true
  }
  return Boolean(data?.length)
}

async function sendWithPriority(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const rpc = getConnection()
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey

  const hasBudget = tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))
  if (!hasBudget) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    )
  }

  tx.sign(...signers)
  const sig = await rpc.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  console.log(`${label} tx confirmed: ${sig}`)
  return sig
}

async function triggerDammV2Migration(ctx: DbcPoolContext): Promise<string | null> {
  if (!AUTO_TRIGGER_MIGRATION) return null
  if (await getBotDryRun()) {
    console.log(`[dbc-graduation] dry run: migration trigger skipped for ${ctx.symbol}`)
    return null
  }

  const wallet = getWallet()
  const migration = await getDbcClient().migration.migrateToDammV2({
    payer: wallet.publicKey,
    virtualPool: ctx.virtualPoolAddress,
    dammConfig: ctx.dammConfig,
  })

  return sendWithPriority(
    migration.transaction,
    [wallet, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair],
    '[dbc-graduation][migrate]',
  )
}

async function waitForDammPool(poolAddress: PublicKey): Promise<boolean> {
  const sdk = await getCpAmm()
  for (let attempt = 1; attempt <= DAMM_POOL_WAIT_ATTEMPTS; attempt++) {
    try {
      const pool = await sdk.fetchPoolState(poolAddress)
      if (pool) return true
    } catch {
      // Pool may not be indexed/created yet.
    }
    await sleep(DAMM_POOL_WAIT_MS)
  }
  return false
}

async function maybeOpenMigratedDammPosition(ctx: DbcPoolContext, row: WatchlistRow, score: DbcMigrationScore): Promise<boolean> {
  const mint = ctx.virtualPool.baseMint.toBase58()
  if (row.opened_position_id) return false
  if (await hasOpenPositionForMint(mint)) {
    await updateWatchlistById(row.id, { status: 'skipped_existing_position' })
    return false
  }

  if (!score.passed) {
    await updateWatchlistById(row.id, {
      status: 'score_rejected',
      metadata: {
        ...(row.metadata ?? {}),
        dbc_score: score.score,
        dbc_score_reason: score.reason,
        dbc_reject_reason: score.rejectReason,
        dbc_score_breakdown: score.breakdown,
      },
    })
    return false
  }

  if (!isMigrated(ctx.virtualPool) && ctx.progressPct >= OPEN_PROGRESS_PCT) {
    try {
      const signature = await triggerDammV2Migration(ctx)
      if (signature) {
        await updateWatchlistById(row.id, {
          status: 'migrating',
          metadata: { ...(row.metadata ?? {}), migration_tx: signature },
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[dbc-graduation] migration trigger failed for ${ctx.symbol}: ${message}`)
      await updateWatchlistById(row.id, {
        status: 'migration_trigger_failed',
        metadata: { ...(row.metadata ?? {}), migration_error: message },
      })
      if (!message.toLowerCase().includes('already')) return false
    }
  }

  const poolReady = await waitForDammPool(ctx.dammPool)
  if (!poolReady) {
    await updateWatchlistById(row.id, { status: ctx.progressPct >= OPEN_PROGRESS_PCT ? 'migration_ready' : 'near_threshold' })
    return false
  }

  const result = await openDammPosition({
    tokenAddress: mint,
    poolAddress: ctx.dammPool.toBase58(),
    solAmount: DAMM_MIGRATION_SOL_PER_POSITION,
    symbol: ctx.symbol,
    ageMinutes: 0,
    feeTvl24hPct: 0,
    liquidityUsd: 0,
    bondingCurvePct: ctx.progressPct,
    strategyId: 'damm-migration',
    positionType: 'damm-migration',
    metadata: {
      source: WATCHLIST_SOURCE,
      virtual_pool: ctx.virtualPoolAddress.toBase58(),
      damm_config: ctx.dammConfig.toBase58(),
      quote_mint: ctx.poolConfig.quoteMint.toBase58(),
      quote_reserve: ctx.virtualPool.quoteReserve.toString(),
      migration_quote_threshold: ctx.poolConfig.migrationQuoteThreshold.toString(),
      dbc_score: score.score,
      dbc_score_breakdown: score.breakdown,
    },
  })

  if (!result.success) {
    await updateWatchlistById(row.id, {
      status: 'open_failed',
      metadata: { ...(row.metadata ?? {}), open_error: result.error ?? 'unknown' },
    })
    return false
  }

  await updateWatchlistById(row.id, {
    status: 'opened',
    graduated_at: new Date().toISOString(),
    opened_position_id: result.positionId ?? null,
    metadata: {
      ...(row.metadata ?? {}),
      open_tx: result.txSignature,
      opened_position_pubkey: result.positionPubkey,
      damm_pool: ctx.dammPool.toBase58(),
    },
  })
  return true
}

async function evaluateVirtualPool(virtualPoolAddress: PublicKey, knownPool?: VirtualPool): Promise<{ tracked: boolean; opened: boolean }> {
  const key = virtualPoolAddress.toBase58()
  if (inFlightPools.has(key)) return { tracked: false, opened: false }
  inFlightPools.add(key)
  try {
    const ctx = await loadPoolContext(virtualPoolAddress, knownPool)
    if (!ctx) return { tracked: false, opened: false }

    const mint = ctx.virtualPool.baseMint.toBase58()
    const existing = await findWatchlistRow(mint)
    const score = evaluateDbcMigrationCandidate(ctx)
    const status = isMigrated(ctx.virtualPool)
      ? score.passed ? 'migrated' : 'score_rejected'
      : ctx.progressPct >= OPEN_PROGRESS_PCT
        ? score.passed ? 'migration_ready' : 'score_rejected'
        : ctx.progressPct >= WATCH_MIN_PROGRESS_PCT
          ? 'near_threshold'
          : 'watching'

    if (!existing && ctx.progressPct < WATCH_MIN_PROGRESS_PCT) {
      return { tracked: false, opened: false }
    }

    const row = await upsertWatchlist(ctx, status, {
      dbc_score: score.score,
      dbc_score_passed: score.passed,
      dbc_score_reason: score.reason,
      dbc_reject_reason: score.rejectReason,
      dbc_score_breakdown: score.breakdown,
      quote_reserve_sol: Math.round(score.quoteReserveSol * 100) / 100,
      migration_threshold_sol: Math.round(score.migrationThresholdSol * 100) / 100,
    })
    if (!row) return { tracked: false, opened: false }

    const shouldOpen = score.passed && (isMigrated(ctx.virtualPool) || ctx.progressPct >= OPEN_PROGRESS_PCT)
    const opened = shouldOpen ? await maybeOpenMigratedDammPosition(ctx, row, score) : false
    return { tracked: true, opened }
  } catch (err) {
    console.warn(`[dbc-graduation] evaluate failed for ${key}:`, err)
    return { tracked: false, opened: false }
  } finally {
    inFlightPools.delete(key)
  }
}

async function fetchTrackedVirtualPools(): Promise<PublicKey[]> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('pre_grad_watchlist')
    .select('metadata')
    .eq('launchpad_source', WATCHLIST_SOURCE)
    .in('status', ['watching', 'near_threshold', 'migration_ready', 'migrating', 'migration_trigger_failed', 'open_failed'])
    .limit(100)

  if (error) {
    console.warn(`[dbc-graduation] tracked pool query failed: ${error.message}`)
    return []
  }

  return (data ?? [])
    .map(row => String((row.metadata as Record<string, unknown> | null)?.virtual_pool ?? ''))
    .filter(Boolean)
    .map(value => new PublicKey(value))
}

function envWatchPoolAddresses(): PublicKey[] {
  return (process.env.DBC_WATCH_POOL_ADDRESSES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new PublicKey(value))
}

async function discoverNearThresholdPools(): Promise<number> {
  const explicit = envWatchPoolAddresses()
  if (explicit.length > 0) {
    const results = await Promise.all(explicit.map(pool => evaluateVirtualPool(pool)))
    return results.filter(result => result.tracked).length
  }

  if (!DISCOVERY_POLL_ENABLED) return 0

  const pools = await getDbcClient().state.getPools()
  let tracked = 0
  let processed = 0
  for (const row of pools) {
    if (processed >= DISCOVERY_MAX_POOLS) break
    processed++
    const result = await evaluateVirtualPool(row.publicKey, row.account)
    if (result.tracked) tracked++
  }
  return tracked
}

export async function runDbcGraduationWatcherTick(): Promise<{ checked: number; tracked: number; opened: number; discovered: number }> {
  const trackedPools = await fetchTrackedVirtualPools()
  let checked = 0
  let tracked = 0
  let opened = 0

  for (const pool of trackedPools) {
    const result = await evaluateVirtualPool(pool)
    checked++
    if (result.tracked) tracked++
    if (result.opened) opened++
  }

  let discovered = 0
  if (Date.now() - lastDiscoveryAt >= DISCOVERY_INTERVAL_MS) {
    lastDiscoveryAt = Date.now()
    discovered = await discoverNearThresholdPools()
  }

  return { checked, tracked, opened, discovered }
}

export async function startDbcGraduationWatcher(): Promise<void> {
  console.log(
    `[dbc-graduation] starting — program=${DBC_PROGRAM_ID.toBase58()} ` +
    `watch>=${WATCH_MIN_PROGRESS_PCT}% open>=${OPEN_PROGRESS_PCT}% ` +
    `minScore=${DBC_MIN_SCORE_TO_OPEN} sol=${DAMM_MIGRATION_SOL_PER_POSITION}`,
  )

  if (USE_PROGRAM_SUBSCRIPTION) {
    getConnection().onProgramAccountChange(DBC_PROGRAM_ID, (event) => {
      void evaluateVirtualPool(event.accountId).catch(err => {
        console.warn('[dbc-graduation] subscription evaluate failed:', err)
      })
    }, 'confirmed')
    console.log('[dbc-graduation] subscribed to DBC program account changes')
  }

  const tick = async () => {
    try {
      const stats = await runDbcGraduationWatcherTick()
      console.log(
        `[dbc-graduation] tick checked=${stats.checked} tracked=${stats.tracked} ` +
        `opened=${stats.opened} discovered=${stats.discovered}`,
      )
    } catch (err) {
      console.error('[dbc-graduation] tick failed:', err)
    }
  }

  await tick()
  setInterval(tick, WATCH_INTERVAL_MS)
}

if (process.env.DBC_GRADUATION_WATCHER_STANDALONE === 'true') {
  startDbcGraduationWatcher().catch(err => {
    console.error('[dbc-graduation] fatal:', err)
    process.exit(1)
  })
}
