import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true, quiet: true })

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
import { createConnection, getRpcEndpointCandidates } from '@/lib/solana'
import { isDailyLossLimitHit } from '@/lib/circuit-breaker'
import { isAuthError, redactSecrets, summarizeError } from '@/lib/logging'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { checkHolders } from '@/lib/helius'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { openDammPosition } from './damm-executor'
import { getRugscore } from './rugcheck-cache'

const DBC_PROGRAM_ID = new PublicKey(
  process.env.DBC_PROGRAM_ID ?? DYNAMIC_BONDING_CURVE_PROGRAM_ID.toString(),
)
const WATCH_INTERVAL_MS = parseInt(process.env.DBC_GRADUATION_WATCH_INTERVAL_SEC ?? '10', 10) * 1_000
const DBC_GRADUATION_WATCHER_ENABLED = process.env.DBC_GRADUATION_WATCHER_ENABLED !== 'false'
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DBC_DISCOVERY_INTERVAL_SEC ?? '60', 10) * 1_000
const WATCH_MIN_PROGRESS_PCT = parseFloat(process.env.DBC_WATCH_MIN_PROGRESS_PCT ?? '90')
const OPEN_PROGRESS_PCT = parseFloat(process.env.DBC_OPEN_PROGRESS_PCT ?? '100')
const DBC_MIN_SCORE_TO_OPEN = parseFloat(process.env.DBC_MIN_SCORE_TO_OPEN ?? '55')
const DBC_MIN_MIGRATION_QUOTE_SOL = parseFloat(process.env.DBC_MIN_MIGRATION_QUOTE_SOL ?? '5')
const DBC_RUGCHECK_GATE_ENABLED = process.env.DBC_RUGCHECK_GATE_ENABLED !== 'false'
const DBC_MIN_RUGCHECK_SCORE = parseFloat(process.env.DBC_MIN_RUGCHECK_SCORE ?? '65')
const DBC_HOLDER_GATE_ENABLED = process.env.DBC_HOLDER_GATE_ENABLED !== 'false'
const DBC_MIN_HOLDER_COUNT = parseInt(process.env.DBC_MIN_HOLDER_COUNT ?? '100', 10)
const DBC_MAX_TOP_HOLDER_PCT = parseFloat(process.env.DBC_MAX_TOP_HOLDER_PCT ?? '35')
const DBC_REQUIRE_TOP_HOLDER_DATA = process.env.DBC_REQUIRE_TOP_HOLDER_DATA !== 'false'
const DBC_REQUIRE_RELIABLE_HOLDERS = process.env.DBC_REQUIRE_RELIABLE_HOLDERS === 'true'
const DAMM_MIGRATION_SOL_PER_POSITION = parseFloat(process.env.DAMM_MIGRATION_SOL_PER_POSITION ?? '0.1')
const AUTO_TRIGGER_MIGRATION = process.env.DBC_AUTO_TRIGGER_MIGRATION === 'true'
const OPEN_MIGRATED_POSITION_ENABLED = process.env.DBC_OPEN_MIGRATED_POSITION_ENABLED === 'true'
const DAMM_MIGRATION_ENABLED = process.env.DAMM_MIGRATION_ENABLED !== 'false'
const MAX_CONCURRENT_DAMM_MIGRATION = parseInt(process.env.MAX_CONCURRENT_DAMM_MIGRATION ?? '2', 10)
const USE_PROGRAM_SUBSCRIPTION = process.env.DBC_USE_PROGRAM_SUBSCRIPTION !== 'false'
const DISCOVERY_POLL_ENABLED = process.env.DBC_DISCOVERY_POLL_ENABLED === 'true'
const DISCOVERY_MAX_POOLS = parseInt(process.env.DBC_DISCOVERY_MAX_POOLS ?? '1000', 10)
const DAMM_POOL_WAIT_ATTEMPTS = parseInt(process.env.DBC_DAMM_POOL_WAIT_ATTEMPTS ?? '12', 10)
const DAMM_POOL_WAIT_MS = parseInt(process.env.DBC_DAMM_POOL_WAIT_MS ?? '2500', 10)
const RPC_RETRY_MS = parseInt(process.env.DBC_RPC_RETRY_SEC ?? '60', 10) * 1_000
const WATCHLIST_SOURCE = 'meteora-dbc'

// Option B: delete stale terminal rows on every upsert to keep the table lean.
// Rows older than this with a terminal status are deleted inline.
const WATCHLIST_STALE_TERMINAL_TTL_MS =
  parseInt(process.env.WATCHLIST_STALE_TERMINAL_TTL_HOURS ?? '48', 10) * 60 * 60 * 1_000
const TERMINAL_STATUSES = [
  'score_rejected',
  'risk_rejected',
  'skipped_existing_position',
  'migration_open_disabled',
  'skipped_circuit_breaker',
  'open_failed',
] as const

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
  rugcheckScore: number | null
  holderCount: number | null
  topHolderPct: number | null
  holderDataReliable: boolean | null
  riskPassed: boolean
  riskReasons: string[]
  breakdown: Record<string, number>
}

type DbcRiskGate = {
  passed: boolean
  rejectReason?: string
  reasons: string[]
  rugcheckScore: number | null
  holderCount: number | null
  topHolderPct: number | null
  holderDataReliable: boolean | null
}

type WatchlistMetricFields = {
  rugcheck_score?: number | null
  holder_count?: number | null
  top_holder_pct?: number | null
}

let connection: Connection | null = null
let dbcClient: DynamicBondingCurveClient | null = null
let cpAmm: any = null
let selectedRpcUrl: string | null = null
let nextRpcRetryAt = 0
let programSubscriptionId: number | null = null
let lastDiscoveryAt = 0
const inFlightPools = new Set<string>()
const inFlightMints = new Set<string>()
let openingMigrationCount = 0

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRpcUrl(): string {
  const url = selectedRpcUrl ?? getRpcEndpointCandidates({ includePublicFallback: true })[0]
  if (!url) throw new Error('[dbc-graduation] RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
  return url
}

function getConnection(): Connection {
  if (!connection) {
    connection = createConnection(getRpcUrl())
  }
  return connection
}

function formatRpcEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    const apiKey = parsed.searchParams.has('api-key') ? '?api-key=redacted' : ''
    return `${parsed.origin}${apiKey}`
  } catch {
    return redactSecrets(url)
  }
}

function resetRpcClients(): void {
  const oldConnection = connection
  const oldSubscriptionId = programSubscriptionId

  connection = null
  dbcClient = null
  cpAmm = null
  selectedRpcUrl = null
  programSubscriptionId = null

  if (oldConnection && oldSubscriptionId !== null) {
    void oldConnection.removeProgramAccountChangeListener(oldSubscriptionId).catch(err => {
      console.warn(`[dbc-graduation] subscription cleanup failed: ${summarizeError(err)}`)
    })
  }
}

async function selectHealthyRpcUrl(): Promise<string | null> {
  const endpoints = getRpcEndpointCandidates({ includePublicFallback: true })
  if (endpoints.length === 0) return null

  for (const endpoint of endpoints) {
    try {
      const probe = createConnection(endpoint)
      await probe.getVersion()
      return endpoint
    } catch (err) {
      console.warn(`[dbc-graduation] RPC probe failed for ${formatRpcEndpoint(endpoint)}: ${summarizeError(err)}`)
    }
  }

  return null
}

async function ensureRpcReady(context: string): Promise<boolean> {
  if (connection) return true

  const now = Date.now()
  if (now < nextRpcRetryAt) return false

  const healthyUrl = await selectHealthyRpcUrl()
  if (!healthyUrl) {
    nextRpcRetryAt = now + RPC_RETRY_MS
    console.warn(`[dbc-graduation] no healthy RPC endpoint for ${context}; retrying in ${Math.round(RPC_RETRY_MS / 1_000)}s`)
    return false
  }

  selectedRpcUrl = healthyUrl
  connection = createConnection(healthyUrl)
  dbcClient = null
  cpAmm = null
  nextRpcRetryAt = 0
  console.log(`[dbc-graduation] using RPC endpoint ${formatRpcEndpoint(healthyUrl)}`)
  return true
}

function markRpcUnhealthy(err: unknown): void {
  if (!isAuthError(err)) return
  resetRpcClients()
  nextRpcRetryAt = Date.now() + RPC_RETRY_MS
}

function subscribeToProgramChanges(): void {
  if (!USE_PROGRAM_SUBSCRIPTION || programSubscriptionId !== null) return

  try {
    programSubscriptionId = getConnection().onProgramAccountChange(DBC_PROGRAM_ID, (event) => {
      void evaluateVirtualPool(event.accountId).catch(err => {
        console.warn(`[dbc-graduation] subscription evaluate failed: ${summarizeError(err)}`)
      })
    }, 'confirmed')
    console.log('[dbc-graduation] subscribed to DBC program account changes')
  } catch (err) {
    console.warn(`[dbc-graduation] subscription failed: ${summarizeError(err)}`)
    markRpcUnhealthy(err)
  }
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

function emptyRiskGate(): DbcRiskGate {
  return {
    passed: true,
    reasons: [],
    rugcheckScore: null,
    holderCount: null,
    topHolderPct: null,
    holderDataReliable: null,
  }
}

function withRiskFields(
  score: Omit<DbcMigrationScore, 'rugcheckScore' | 'holderCount' | 'topHolderPct' | 'holderDataReliable' | 'riskPassed' | 'riskReasons'>,
  risk: DbcRiskGate = emptyRiskGate(),
): DbcMigrationScore {
  return {
    ...score,
    rugcheckScore: risk.rugcheckScore,
    holderCount: risk.holderCount,
    topHolderPct: risk.topHolderPct,
    holderDataReliable: risk.holderDataReliable,
    riskPassed: risk.passed,
    riskReasons: risk.reasons,
  }
}

async function evaluateDbcRiskGate(ctx: DbcPoolContext): Promise<DbcRiskGate> {
  const mint = ctx.virtualPool.baseMint.toBase58()
  const risk = emptyRiskGate()

  if (DBC_RUGCHECK_GATE_ENABLED) {
    risk.rugcheckScore = await getRugscore(mint, ctx.symbol)
    if (risk.rugcheckScore < DBC_MIN_RUGCHECK_SCORE) {
      risk.rejectReason ??= 'rugcheck_below_threshold'
      risk.reasons.push(`rugcheck ${risk.rugcheckScore} < ${DBC_MIN_RUGCHECK_SCORE}`)
    }
  }

  if (DBC_HOLDER_GATE_ENABLED) {
    const holders = await checkHolders(mint)
    risk.holderCount = holders.holderCount
    risk.topHolderPct = holders.topHolderPct
    risk.holderDataReliable = holders.reliable

    if (DBC_REQUIRE_RELIABLE_HOLDERS && !holders.reliable) {
      risk.rejectReason ??= 'holder_count_not_reliable'
      risk.reasons.push('holder count is not reliable')
    }
    if (DBC_MIN_HOLDER_COUNT > 0 && holders.holderCount < DBC_MIN_HOLDER_COUNT) {
      risk.rejectReason ??= 'holder_count_below_threshold'
      risk.reasons.push(`holders ${holders.holderCount} < ${DBC_MIN_HOLDER_COUNT}`)
    }
    if (DBC_REQUIRE_TOP_HOLDER_DATA && holders.topHolderPct <= 0) {
      risk.rejectReason ??= 'top_holder_data_missing'
      risk.reasons.push('top holder data missing')
    } else if (holders.topHolderPct > DBC_MAX_TOP_HOLDER_PCT) {
      risk.rejectReason ??= 'top_holder_above_threshold'
      risk.reasons.push(`top holder ${holders.topHolderPct.toFixed(1)}% > ${DBC_MAX_TOP_HOLDER_PCT}%`)
    }
  }

  risk.passed = risk.reasons.length === 0
  return risk
}

async function evaluateDbcMigrationCandidate(ctx: DbcPoolContext): Promise<DbcMigrationScore> {
  const quoteMint = ctx.poolConfig.quoteMint.toBase58()
  const quoteReserveSol = solFromLamports(ctx.virtualPool.quoteReserve)
  const migrationThresholdSol = solFromLamports(ctx.poolConfig.migrationQuoteThreshold)
  const breakdown: Record<string, number> = {}

  if (quoteMint !== NATIVE_MINT.toBase58()) {
    return withRiskFields({
      score: 0,
      passed: false,
      reason: 'quote mint is not WSOL',
      rejectReason: 'quote_not_wsol',
      quoteReserveSol,
      migrationThresholdSol,
      breakdown,
    })
  }

  if (migrationThresholdSol < DBC_MIN_MIGRATION_QUOTE_SOL) {
    return withRiskFields({
      score: 0,
      passed: false,
      reason: `migration quote threshold ${migrationThresholdSol.toFixed(2)} SOL < ${DBC_MIN_MIGRATION_QUOTE_SOL} SOL`,
      rejectReason: 'migration_threshold_too_small',
      quoteReserveSol,
      migrationThresholdSol,
      breakdown,
    })
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
  const risk = await evaluateDbcRiskGate(ctx)
  const scorePassed = score >= DBC_MIN_SCORE_TO_OPEN
  const passed = scorePassed && risk.passed
  return withRiskFields({
    score,
    passed,
    reason: !risk.passed
      ? risk.reasons.join('; ')
      : scorePassed
        ? `score ${score} >= ${DBC_MIN_SCORE_TO_OPEN}; risk gates passed`
        : `score ${score} < ${DBC_MIN_SCORE_TO_OPEN}`,
    rejectReason: !risk.passed
      ? risk.rejectReason
      : scorePassed ? undefined : 'score_below_threshold',
    quoteReserveSol,
    migrationThresholdSol,
    breakdown,
  }, risk)
}

function rejectedStatus(score: DbcMigrationScore): string {
  return score.rejectReason === 'score_below_threshold' ? 'score_rejected' : 'risk_rejected'
}

function isInvalidAccountDiscriminator(err: unknown): boolean {
  return summarizeError(err).toLowerCase().includes('invalid account discriminator')
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
  let virtualPool: VirtualPool | null
  try {
    virtualPool = knownPool ?? await client.state.getPool(virtualPoolAddress)
  } catch (err) {
    if (isInvalidAccountDiscriminator(err)) return null
    throw err
  }
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

/**
 * Option B: inline stale-row cleanup.
 * Deletes terminal-status rows older than WATCHLIST_STALE_TERMINAL_TTL_MS on every upsert call.
 * Keeps the working set lean without a separate cron job.
 */
async function pruneStaleTerminalRows(supabase: ReturnType<typeof createServerClient>): Promise<void> {
  const cutoff = new Date(Date.now() - WATCHLIST_STALE_TERMINAL_TTL_MS).toISOString()
  const { error } = await supabase
    .from('pre_grad_watchlist')
    .delete()
    .in('status', TERMINAL_STATUSES)
    .lt('last_seen_at', cutoff)
  if (error) {
    console.warn(`[dbc-graduation] stale row pruning failed: ${error.message}`)
  }
}

async function upsertWatchlist(
  ctx: DbcPoolContext,
  status: string,
  extraMetadata: Record<string, unknown> = {},
  metricFields: WatchlistMetricFields = {},
): Promise<WatchlistRow | null> {
  const supabase = createServerClient()

  // Fire-and-forget pruning — runs on every upsert, non-blocking on failure
  pruneStaleTerminalRows(supabase).catch(err =>
    console.warn(`[dbc-graduation] pruneStaleTerminalRows error: ${err}`)
  )

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
    ...metricFields,
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

async function getOpenDammMigrationCount(): Promise<number> {
  const supabase = createServerClient()
  const { count, error } = await supabase
    .from('lp_positions')
    .select('id', { count: 'exact', head: true })
    .eq('position_type', 'damm-migration')
    .in('status', ['active', 'out_of_range'])

  if (error) {
    console.warn(`[dbc-graduation] open damm-migration count failed: ${error.message}`)
    return Number.POSITIVE_INFINITY
  }
  return count ?? 0
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
  if (!DAMM_MIGRATION_ENABLED) return null
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
  if (!DAMM_MIGRATION_ENABLED || !OPEN_MIGRATED_POSITION_ENABLED) {
    await updateWatchlistById(row.id, { status: 'migration_open_disabled' })
    return false
  }
  if (row.opened_position_id) return false
  if (row.status === 'opening' || row.status === 'opened') return false
  if (inFlightMints.has(mint)) return false
  inFlightMints.add(mint)

  try {
    if (await hasOpenPositionForMint(mint)) {
      await updateWatchlistById(row.id, { status: 'skipped_existing_position' })
      return false
    }

    if (!score.passed) {
      await updateWatchlistById(row.id, {
        status: rejectedStatus(score),
        metadata: {
          ...(row.metadata ?? {}),
          dbc_score: score.score,
          dbc_score_reason: score.reason,
          dbc_reject_reason: score.rejectReason,
          dbc_score_breakdown: score.breakdown,
          dbc_risk_passed: score.riskPassed,
          dbc_risk_reasons: score.riskReasons,
          rugcheck_score: score.rugcheckScore,
          holder_count: score.holderCount,
          top_holder_pct: score.topHolderPct,
          holder_data_reliable: score.holderDataReliable,
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
        const message = summarizeError(err)
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

    const openMigrationCount = await getOpenDammMigrationCount()
    if (openMigrationCount + openingMigrationCount >= MAX_CONCURRENT_DAMM_MIGRATION) {
      console.log(
        `[DBC] max concurrent damm-migration positions reached (${openMigrationCount + openingMigrationCount}/${MAX_CONCURRENT_DAMM_MIGRATION}) — skipping`,
      )
      await updateWatchlistById(row.id, {
        status: 'skipped_migration_cap',
        metadata: {
          ...(row.metadata ?? {}),
          open_migration_count: openMigrationCount,
          opening_migration_count: openingMigrationCount,
          max_concurrent_damm_migration: MAX_CONCURRENT_DAMM_MIGRATION,
        },
      })
      return false
    }

    if (await isDailyLossLimitHit()) {
      console.warn('[DBC] daily loss circuit breaker active — skipping migration open')
      await updateWatchlistById(row.id, { status: 'skipped_circuit_breaker' })
      return false
    }

    await updateWatchlistById(row.id, {
      status: 'opening',
      metadata: { ...(row.metadata ?? {}), opening_started_at: new Date().toISOString() },
    })

    openingMigrationCount++
    let result: Awaited<ReturnType<typeof openDammPosition>>
    try {
      result = await openDammPosition({
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
          rugcheck_score: score.rugcheckScore,
          holder_count: score.holderCount,
          top_holder_pct: score.topHolderPct,
          holder_data_reliable: score.holderDataReliable,
        },
      })
    } finally {
      openingMigrationCount = Math.max(0, openingMigrationCount - 1)
    }

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
  } finally {
    inFlightMints.delete(mint)
  }
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

    if (!existing && ctx.progressPct < WATCH_MIN_PROGRESS_PCT) {
      return { tracked: false, opened: false }
    }

    const score = await evaluateDbcMigrationCandidate(ctx)
    const status = isMigrated(ctx.virtualPool)
      ? score.passed ? 'migrated' : rejectedStatus(score)
      : ctx.progressPct >= OPEN_PROGRESS_PCT
        ? score.passed ? 'migration_ready' : rejectedStatus(score)
        : ctx.progressPct >= WATCH_MIN_PROGRESS_PCT
          ? 'near_threshold'
          : 'watching'

    const row = await upsertWatchlist(ctx, status, {
      dbc_score: score.score,
      dbc_score_passed: score.passed,
      dbc_score_reason: score.reason,
      dbc_reject_reason: score.rejectReason,
      dbc_score_breakdown: score.breakdown,
      dbc_risk_passed: score.riskPassed,
      dbc_risk_reasons: score.riskReasons,
      rugcheck_score: score.rugcheckScore,
      holder_count: score.holderCount,
      top_holder_pct: score.topHolderPct,
      holder_data_reliable: score.holderDataReliable,
      quote_reserve_sol: Math.round(score.quoteReserveSol * 100) / 100,
      migration_threshold_sol: Math.round(score.migrationThresholdSol * 100) / 100,
    }, {
      rugcheck_score: score.rugcheckScore,
      holder_count: score.holderCount,
      top_holder_pct: score.topHolderPct,
    })
    if (!row) return { tracked: false, opened: false }

    const shouldOpen = score.passed && (isMigrated(ctx.virtualPool) || ctx.progressPct >= OPEN_PROGRESS_PCT)
    const opened = shouldOpen ? await maybeOpenMigratedDammPosition(ctx, row, score) : false
    return { tracked: true, opened }
  } catch (err) {
    console.warn(`[dbc-graduation] evaluate failed for ${key}: ${summarizeError(err)}`)
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
    .in('status', ['watching', 'near_threshold', 'migration_ready', 'migrating', 'migration_trigger_failed'])
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

  let pools: Awaited<ReturnType<DynamicBondingCurveClient['state']['getPools']>>
  try {
    pools = await getDbcClient().state.getPools()
  } catch (err) {
    console.warn(`[dbc-graduation] discovery skipped: ${summarizeError(err)}`)
    return 0
  }

  let tracked = 0
  const BATCH_SIZE = 20
  const maxPools = Math.min(pools.length, DISCOVERY_MAX_POOLS)
  for (let i = 0; i < maxPools; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(row => evaluateVirtualPool(row.publicKey, row.account)))
    tracked += results.filter(result => result.tracked).length
  }
  return tracked
}

export async function runDbcGraduationWatcherTick(): Promise<{ checked: number; tracked: number; opened: number; discovered: number }> {
  if (!DBC_GRADUATION_WATCHER_ENABLED) {
    console.log('[dbc-graduation] watcher disabled — DBC_GRADUATION_WATCHER_ENABLED=false')
    return { checked: 0, tracked: 0, opened: 0, discovered: 0 }
  }

  await refreshRpcProviderCooldown('helius')

  if (!await ensureRpcReady('tick')) {
    return { checked: 0, tracked: 0, opened: 0, discovered: 0 }
  }
  subscribeToProgramChanges()

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
  if (!DBC_GRADUATION_WATCHER_ENABLED) {
    console.log('[dbc-graduation] disabled — DBC_GRADUATION_WATCHER_ENABLED=false')
    return
  }

  console.log(
    `[dbc-graduation] starting — program=${DBC_PROGRAM_ID.toBase58()} ` +
    `watch>=${WATCH_MIN_PROGRESS_PCT}% open>=${OPEN_PROGRESS_PCT}% ` +
    `minScore=${DBC_MIN_SCORE_TO_OPEN} rug>=${DBC_MIN_RUGCHECK_SCORE} ` +
    `holders>=${DBC_MIN_HOLDER_COUNT} topHolder<=${DBC_MAX_TOP_HOLDER_PCT}% ` +
    `sol=${DAMM_MIGRATION_SOL_PER_POSITION}`,
  )

  await refreshRpcProviderCooldown('helius')

  if (await ensureRpcReady('startup')) {
    subscribeToProgramChanges()
  }

  const tick = async () => {
    try {
      const stats = await runDbcGraduationWatcherTick()
      console.log(
        `[dbc-graduation] tick checked=${stats.checked} tracked=${stats.tracked} ` +
        `opened=${stats.opened} discovered=${stats.discovered}`,
      )
    } catch (err) {
      markRpcUnhealthy(err)
      console.error(`[dbc-graduation] tick failed: ${summarizeError(err)}`)
    }
  }

  await tick()
  setInterval(tick, WATCH_INTERVAL_MS)
}

if (process.env.DBC_GRADUATION_WATCHER_STANDALONE === 'true') {
  startDbcGraduationWatcher().catch(err => {
    console.error(`[dbc-graduation] fatal: ${summarizeError(err)}`)
    process.exit(1)
  })
}
