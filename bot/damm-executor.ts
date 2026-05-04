/**
 * bot/damm-executor.ts — FULL PRODUCTION DAMM v2 Executor
 *
 * - Real open:  createPositionAndAddLiquidity via @meteora-ag/cp-amm-sdk
 *   Uses single-sided SOL deposit: maxAmountToken[A|B] = lamports, other side = 0.
 *   liquidityDelta computed via sdk.getDepositQuote().
 *   Saves to lp_positions with strategy_id = 'damm-edge' or 'damm-migration'.
 *
 * - Real close: zapOutThroughDammV2 via @meteora-ag/zap-sdk → everything to SOL.
 *   Loads position row from Supabase by positionId before calling zap.
 *   After confirmation, fetches Meteora DAMM v2 position API (4× retry, 1.5s gap)
 *   for authoritative USD PnL and writes realized_pnl_usd top-level + metadata.
 *   Return value now includes realizedPnlUsd + totalFeeEarnedUsd so callers
 *   (handleDammExit) can surface them in Telegram alerts without a second fetch.
 *
 * - dry_run: read from bot_state table at open time (same as executor.ts/monitor.ts).
 * - Wallet: loaded from WALLET_PRIVATE_KEY env (base58), never from PublicKey alone.
 * - Lazy imports: all SDK imports are dynamic to prevent Next.js build-time IDL crash.
 *
 * ISOLATION RULE: Must NOT import from bot/executor.ts or bot/monitor.ts.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import type { DammPositionParams, DammPositionStrategyId } from '@/lib/types'
import { getBotState } from '@/lib/botState'
import { createServerClient } from '@/lib/supabase'
import { getDammSolPriceFromPoolState, type DammSolPrice } from '@/lib/damm-price'
import {
  OPEN_LP_STATUSES,
  assertCanOpenLpPosition,
  matchesOpenLpScope,
  type OpenLpScope,
} from '@/lib/position-limits'
import { getRpcEndpointCandidates } from '@/lib/solana'
import { summarizeError } from '@/lib/logging'
import { sendAlert } from './alerter'

const METEORA_DAMM_API = 'https://amm-v2.meteora.ag'
const METEORA_DAMM_V2_DATAPI = 'https://damm-v2.datapi.meteora.ag'
const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5',
)
const MAX_CONCURRENT_DAMM_MIGRATION_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_DAMM_MIGRATION_POSITIONS ?? '1',
)
const MAX_MARKET_LP_SOL_DEPLOYED = parseFloat(
  process.env.MAX_MARKET_LP_SOL_DEPLOYED ?? process.env.MAX_TOTAL_SOL_DEPLOYED ?? '1',
)
const DAMM_MIGRATION_SOL_PER_POSITION = parseFloat(process.env.DAMM_MIGRATION_SOL_PER_POSITION ?? '1')
const MAX_DAMM_MIGRATION_SOL_DEPLOYED = parseFloat(
  process.env.MAX_DAMM_MIGRATION_SOL_DEPLOYED ??
  String(DAMM_MIGRATION_SOL_PER_POSITION * MAX_CONCURRENT_DAMM_MIGRATION_POSITIONS),
)
const DAMM_POOL_RESOLVE_TIMEOUT_MS = parseInt(process.env.DAMM_POOL_RESOLVE_TIMEOUT_MS ?? '6000', 10)
const DAMM_POOL_RESOLVE_PAGE_SIZE = Math.min(
  1000,
  Math.max(1, parseInt(process.env.DAMM_POOL_RESOLVE_PAGE_SIZE ?? '20', 10)),
)
const DAMM_POOL_RESOLVE_CANDIDATE_LIMIT = Math.min(
  20,
  Math.max(1, parseInt(process.env.DAMM_POOL_RESOLVE_CANDIDATE_LIMIT ?? '8', 10)),
)
const CLOSEABLE_DAMM_STATUSES = [...OPEN_LP_STATUSES, 'dry_run']
const WSOL_MINT = NATIVE_MINT.toBase58()

type DammPoolCandidateSource = 'provided' | 'datapi'

type DammPoolCandidate = {
  address: string
  source: DammPoolCandidateSource
  tvlUsd?: number
}

type VerifiedDammPool = {
  poolAddress: string
  source: DammPoolCandidateSource
  tokenAMint: string
  tokenBMint: string
}

type DammV2PoolApiToken = {
  address?: unknown
  symbol?: unknown
}

type DammV2PoolApiPool = {
  address?: unknown
  token_x?: DammV2PoolApiToken
  token_y?: DammV2PoolApiToken
  tvl?: unknown
  is_blacklisted?: unknown
}

// ── Lazy singleton helpers ─────────────────────────────────────────────────────

let _connection: Connection | null = null
let _cpAmm: any = null
let _zap: any = null

function getRpcUrl(): string {
  const url = getRpcEndpointCandidates()[0]
  if (!url) throw new Error('[DAMM] RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
  return url
}

function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getRpcUrl(), 'confirmed')
  }
  return _connection
}

function getWallet(): Keypair {
  const key = process.env.WALLET_PRIVATE_KEY
  if (!key) throw new Error('[DAMM] WALLET_PRIVATE_KEY not set')
  try {
    if (key.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)))
    }
    return Keypair.fromSecretKey(bs58.decode(key))
  } catch {
    throw new Error('[DAMM] WALLET_PRIVATE_KEY is invalid — must be base58 or JSON uint8 array')
  }
}

function getDammOpenConfig(params: DammPositionParams): {
  label: string
  maxConcurrent: number
  maxDeployedSol: number
  scope: OpenLpScope
  strategyId: DammPositionStrategyId
  positionType: DammPositionStrategyId
} {
  const strategyId = params.strategyId ?? 'damm-edge'
  const isMigration = strategyId === 'damm-migration' || params.positionType === 'damm-migration'
  if (isMigration) {
    return {
      label: '[DAMM-MIGRATION]',
      maxConcurrent: MAX_CONCURRENT_DAMM_MIGRATION_POSITIONS,
      maxDeployedSol: MAX_DAMM_MIGRATION_SOL_DEPLOYED,
      scope: 'damm-migration',
      strategyId: 'damm-migration',
      positionType: 'damm-migration',
    }
  }

  return {
    label: '[DAMM]',
    maxConcurrent: MAX_CONCURRENT_MARKET_LP_POSITIONS,
    maxDeployedSol: MAX_MARKET_LP_SOL_DEPLOYED,
    scope: 'market',
    strategyId: 'damm-edge',
    positionType: 'damm-edge',
  }
}

async function getScopedOpenSolDeployed(scope: OpenLpScope): Promise<number> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .select('sol_deposited, strategy_id, position_type')
    .in('status', OPEN_LP_STATUSES)

  if (error) {
    throw new Error(`open SOL exposure query failed: ${error.message}`)
  }

  return (data ?? [])
    .filter(position => matchesOpenLpScope(position, scope))
    .reduce((sum, position) => sum + Number(position.sol_deposited ?? 0), 0)
}

async function getCpAmm(): Promise<any> {
  if (!_cpAmm) {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')
    _cpAmm = new CpAmm(getConnection())
  }
  return _cpAmm
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function normalizeMint(value: unknown): string | null {
  return asString(value)
}

function getApiPoolTokenAddresses(pool: DammV2PoolApiPool): [string | null, string | null] {
  return [
    normalizeMint(pool.token_x?.address),
    normalizeMint(pool.token_y?.address),
  ]
}

function apiPoolMatchesTokenPair(pool: DammV2PoolApiPool, tokenAddress: string, quoteMint: string): boolean {
  if (pool.is_blacklisted === true) return false
  const [tokenX, tokenY] = getApiPoolTokenAddresses(pool)
  const mints = [tokenX, tokenY]
  return mints.includes(tokenAddress) && mints.includes(quoteMint)
}

function poolStateMatchesTokenPair(poolState: any, tokenAddress: string, quoteMint: string): {
  matches: boolean
  tokenAMint?: string
  tokenBMint?: string
} {
  const tokenAMint = poolState?.tokenAMint?.toBase58?.()
  const tokenBMint = poolState?.tokenBMint?.toBase58?.()
  const mints = [tokenAMint, tokenBMint]
  return {
    matches: Boolean(tokenAMint && tokenBMint && mints.includes(tokenAddress) && mints.includes(quoteMint)),
    tokenAMint,
    tokenBMint,
  }
}

async function fetchDammPoolJson(url: URL): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DAMM_POOL_RESOLVE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchDammPoolCandidatesFromDataApi(
  tokenAddress: string,
  quoteMint: string,
): Promise<DammPoolCandidate[]> {
  const url = new URL('/pools', METEORA_DAMM_V2_DATAPI)
  url.searchParams.set('query', tokenAddress)
  url.searchParams.set('page_size', String(DAMM_POOL_RESOLVE_PAGE_SIZE))
  url.searchParams.set('sort_by', 'tvl:desc')
  url.searchParams.set('filter_by', 'is_blacklisted=false')

  try {
    const json = await fetchDammPoolJson(url)
    const data = json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: unknown[] }).data
      : []

    return data
      .filter((entry): entry is DammV2PoolApiPool => Boolean(entry && typeof entry === 'object'))
      .filter(pool => apiPoolMatchesTokenPair(pool, tokenAddress, quoteMint))
      .map(pool => ({
        address: asString(pool.address) ?? '',
        source: 'datapi' as const,
        tvlUsd: asNumber(pool.tvl),
      }))
      .filter(candidate => Boolean(candidate.address))
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
      .slice(0, DAMM_POOL_RESOLVE_CANDIDATE_LIMIT)
  } catch (err: any) {
    console.warn(`[DAMM] DAMM v2 pool lookup failed for ${tokenAddress}: ${err?.message ?? String(err)}`)
    return []
  }
}

/**
 * Resolve a token to an existing, verified DAMM v2 WSOL pool.
 *
 * The scanner may discover a DLMM pool first. This helper treats that address
 * only as a candidate, then proves the final pool through the DAMM v2 program
 * before openDammPosition receives it.
 */
export async function resolveVerifiedDammV2PoolForToken({
  tokenAddress,
  preferredPoolAddress,
  quoteMint = WSOL_MINT,
}: {
  tokenAddress: string
  preferredPoolAddress?: string
  quoteMint?: string
}): Promise<VerifiedDammPool | null> {
  const token = new PublicKey(tokenAddress).toBase58()
  const quote = new PublicKey(quoteMint).toBase58()
  const candidates: DammPoolCandidate[] = []

  if (preferredPoolAddress) {
    candidates.push({ address: preferredPoolAddress, source: 'provided' })
  }
  candidates.push(...await fetchDammPoolCandidatesFromDataApi(token, quote))

  const uniqueCandidates = Array.from(
    new Map(candidates.map(candidate => [candidate.address, candidate])).values(),
  )

  const sdk = await getCpAmm()
  for (const candidate of uniqueCandidates) {
    try {
      const pool = new PublicKey(candidate.address)
      const poolState = await sdk.fetchPoolState(pool)
      const match = poolStateMatchesTokenPair(poolState, token, quote)
      if (!match.matches || !match.tokenAMint || !match.tokenBMint) {
        console.warn(
          `[DAMM] rejected pool candidate ${candidate.address}: ` +
          `expected ${token}/${quote}, got ${match.tokenAMint ?? 'unknown'}/${match.tokenBMint ?? 'unknown'}`,
        )
        continue
      }

      return {
        poolAddress: candidate.address,
        source: candidate.source,
        tokenAMint: match.tokenAMint,
        tokenBMint: match.tokenBMint,
      }
    } catch (err: any) {
      console.warn(
        `[DAMM] rejected pool candidate ${candidate.address}: ${err?.message ?? String(err)}`,
      )
    }
  }

  return null
}

async function getZap(): Promise<any> {
  if (!_zap) {
    const { Zap } = await import('@meteora-ag/zap-sdk')
    _zap = new Zap(getConnection())
  }
  return _zap
}

async function resolveTransaction(txOrBuilder: any): Promise<Transaction> {
  if (txOrBuilder && typeof txOrBuilder.build === 'function') {
    return txOrBuilder.build()
  }
  return txOrBuilder as Transaction
}

async function sendWithPriority(
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey

  const hasBudget = tx.instructions.some(
    ix => ix.programId.equals(ComputeBudgetProgram.programId),
  )
  if (!hasBudget) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    )
  }

  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  console.log(`${label} tx confirmed: ${sig}`)
  return sig
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Read dry_run through the shared bot state helper, matching DLMM behavior. */
async function getBotDryRun(): Promise<boolean> {
  const botState = await getBotState()
  return process.env.BOT_DRY_RUN === 'true' || botState.dry_run
}

/**
 * Fetch realized PnL (USD) from the Meteora DAMM v2 position API.
 * Retries up to 4 times with 1.5s gaps to tolerate post-tx API lag (1–3s typical).
 * Returns null after all attempts fail — caller still closes row cleanly.
 */
async function fetchDammPositionPnlWithRetry(positionPubkey: string): Promise<{
  realized_pnl_usd: number
  total_fee_earned_usd: number
} | null> {
  const ATTEMPTS = 4
  const DELAY_MS = 1_500

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${METEORA_DAMM_API}/position/${positionPubkey}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        console.warn(`[DAMM] PnL API attempt ${attempt}/${ATTEMPTS} — HTTP ${res.status}`)
      } else {
        const json = await res.json()
        const realized_pnl_usd     = Number(json?.position_pnl_usd    ?? json?.pnl_usd    ?? NaN)
        const total_fee_earned_usd  = Number(json?.total_fee_earned_usd ?? json?.fee_earned_usd ?? NaN)
        if (!isNaN(realized_pnl_usd)) {
          console.log(`[DAMM] PnL API resolved on attempt ${attempt}: $${realized_pnl_usd}`)
          return {
            realized_pnl_usd,
            total_fee_earned_usd: isNaN(total_fee_earned_usd) ? 0 : total_fee_earned_usd,
          }
        }
        console.warn(`[DAMM] PnL API attempt ${attempt}/${ATTEMPTS} — missing position_pnl_usd:`, JSON.stringify(json).slice(0, 200))
      }
    } catch (e) {
      console.warn(`[DAMM] PnL API attempt ${attempt}/${ATTEMPTS} threw: ${summarizeError(e)}`)
    }

    if (attempt < ATTEMPTS) {
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
  }

  console.warn('[DAMM] fetchDammPositionPnlWithRetry: all attempts exhausted — realized_pnl_usd will be null')
  return null
}

// ── Open ───────────────────────────────────────────────────────────────────────

/**
 * Open a DAMM v2 position for the given token/pool.
 *
 * Flow:
 *   1. Guard: read dry_run from bot_state table.
 *   2. Fetch pool state to get sqrtPrice, vaults, mints, programs, collectFeeMode.
 *   3. Determine which side is SOL; build maxAmountToken[A|B].
 *   4. Compute liquidityDelta via sdk.getDepositQuote() for single-sided deposit.
 *   5. Generate fresh position NFT Keypair.
 *   6. Call sdk.createPositionAndAddLiquidity() → build → sign → confirm.
 *   7. Persist to lp_positions with the caller's DAMM strategy id.
 *      entry_price_sol is captured as normalized SOL/token at open so TP/SL have a baseline.
 *   8. Fire pre_grad_opened Telegram alert.
 */
export async function openDammPosition(
  params: DammPositionParams,
): Promise<{ positionPubkey: string; txSignature: string; success: boolean; positionId?: string; error?: string }> {
  const openConfig = getDammOpenConfig(params)
  console.log(`${openConfig.label} Opening position — pool=${params.poolAddress} sol=${params.solAmount}`)

  try {
    // 1. dry_run guard — match DLMM bot_state + BOT_DRY_RUN behavior
    const dryRun = await getBotDryRun()
    console.log(`[DAMM] dry_run=${dryRun}`)

    if (dryRun) {
      const positionId = await saveDammPosition({
        params,
        openConfig,
        positionPubkey: 'DRY_RUN',
        signature: 'DRY_RUN',
        solDeposited: params.solAmount,
        entryPriceSol: 0,
        dryRun: true,
      })

      await sendAlert({
        type: 'pre_grad_opened',
        symbol: params.symbol,
        positionId,
        poolAddress: params.poolAddress,
        bondingCurvePct: params.bondingCurvePct ?? 0,
      })

      console.log('[DAMM] dry_run=true — row persisted, alert sent, skipping real open')
      return { positionPubkey: positionId, txSignature: 'DRY_RUN', success: true, positionId }
    }

    const limitState = await assertCanOpenLpPosition(openConfig.maxConcurrent, openConfig.label, openConfig.scope)
    console.log(
      `${openConfig.label} ${openConfig.scope} LP cap ok (${limitState.effectiveOpenCount}/${openConfig.maxConcurrent}; ` +
      `source=${limitState.countSource}, live=${limitState.liveOpenCount}, ` +
      `liveScoped=${limitState.liveScopedOpenCount}, cached=${limitState.cachedOpenCount})`,
    )
    const deployedSol = await getScopedOpenSolDeployed(openConfig.scope)
    if (deployedSol + params.solAmount > openConfig.maxDeployedSol) {
      throw new Error(
        `${openConfig.label} ${openConfig.scope} SOL cap hit ` +
        `(${(deployedSol + params.solAmount).toFixed(3)}/${openConfig.maxDeployedSol} SOL)`,
      )
    }

    const sdk = await getCpAmm()
    const wallet = getWallet()
    const pool = new PublicKey(params.poolAddress)
    const positionNftKp = Keypair.generate()

    // 2. Fetch pool state
    const poolState = await sdk.fetchPoolState(pool)
    if (!poolState) throw new Error('[DAMM] Pool not found or paused')

    const {
      tokenAMint,
      tokenBMint,
      sqrtPrice,
      sqrtMinPrice,
      sqrtMaxPrice,
      liquidity,
      collectFeeMode,
      tokenAFlag,
      tokenBFlag,
    } = poolState

    // Capture normalized SOL/token entry price from sqrtPrice at the moment of open.
    const entryPrice = await getDammSolPriceFromPoolState(getConnection(), poolState)
    if (!entryPrice) throw new Error('[DAMM] Could not derive SOL/token entry price from pool state')
    const entryPriceSol = entryPrice.solPerToken

    // 3. Token programs — tokenFlag: 0 = SPL, 1 = Token2022
    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
    const tokenAProgram = tokenAFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const tokenBProgram = tokenBFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

    const WSOL = NATIVE_MINT.toBase58()
    const isTokenASol = tokenAMint.toBase58() === WSOL
    const isTokenBSol = tokenBMint.toBase58() === WSOL

    if (!isTokenASol && !isTokenBSol) {
      throw new Error('[DAMM] Neither token is SOL — single-sided SOL deposit not possible')
    }

    const lamports = Math.floor(params.solAmount * 1e9)
    const solBN = new BN(lamports)
    const zeroBN = new BN(0)

    // 4. Compute liquidityDelta for single-sided deposit
    let liquidityDelta: BN
    let maxAmountTokenA: BN
    let maxAmountTokenB: BN

    if (isTokenASol) {
      if (sqrtPrice.gte(sqrtMaxPrice)) {
        throw new Error('[DAMM] sqrtPrice >= sqrtMaxPrice — cannot deposit token A only')
      }
      const quote = sdk.getDepositQuote({
        inAmount: solBN,
        isTokenA: true,
        minSqrtPrice: sqrtMinPrice,
        maxSqrtPrice: sqrtMaxPrice,
        sqrtPrice,
        collectFeeMode,
        tokenAAmount: poolState.tokenAAmount,
        tokenBAmount: poolState.tokenBAmount,
        liquidity,
      })
      liquidityDelta = quote.liquidityDelta
      maxAmountTokenA = solBN
      maxAmountTokenB = zeroBN
    } else {
      if (sqrtPrice.lte(sqrtMinPrice)) {
        throw new Error('[DAMM] sqrtPrice <= sqrtMinPrice — cannot deposit token B only')
      }
      const quote = sdk.getDepositQuote({
        inAmount: solBN,
        isTokenA: false,
        minSqrtPrice: sqrtMinPrice,
        maxSqrtPrice: sqrtMaxPrice,
        sqrtPrice,
        collectFeeMode,
        tokenAAmount: poolState.tokenAAmount,
        tokenBAmount: poolState.tokenBAmount,
        liquidity,
      })
      liquidityDelta = quote.liquidityDelta
      maxAmountTokenA = zeroBN
      maxAmountTokenB = solBN
    }

    if (liquidityDelta.isZero()) {
      throw new Error('[DAMM] liquidityDelta is zero — pool may be full range or price is at boundary')
    }

    console.log(`[DAMM] liquidityDelta=${liquidityDelta.toString()} isTokenASol=${isTokenASol} entryPriceSol=${entryPriceSol}`)

    // 5. createPositionAndAddLiquidity
    const rawTx = await sdk.createPositionAndAddLiquidity({
      owner: wallet.publicKey,
      pool,
      positionNft: positionNftKp.publicKey,
      liquidityDelta,
      maxAmountTokenA,
      maxAmountTokenB,
      tokenAAmountThreshold: maxAmountTokenA.muln(99).divn(100),
      tokenBAmountThreshold: maxAmountTokenB.muln(99).divn(100),
      tokenAMint,
      tokenBMint,
      tokenAProgram,
      tokenBProgram,
    })

    const tx = await resolveTransaction(rawTx)
    const signature = await sendWithPriority(tx, [wallet, positionNftKp], '[DAMM][open]')

    const { derivePositionAddress } = await import('@meteora-ag/cp-amm-sdk')
    const positionPda = derivePositionAddress(positionNftKp.publicKey)
    const positionPubkey = positionPda.toBase58()

    console.log(`[DAMM] ✅ Opened: pos=${positionPubkey} sig=${signature}`)

    // 6. Persist — entry_price_sol written as normalized SOL/token, dry_run from bot_state
    const positionId = await saveDammPosition({
      params,
      openConfig,
      positionPubkey,
      signature,
      solDeposited: params.solAmount,
      entryPriceSol,
      entryPrice,
      dryRun,
    })

    // 7. Fire Telegram alert
    await sendAlert({
      type: 'pre_grad_opened',
      symbol: params.symbol,
      positionId,
      poolAddress: params.poolAddress,
      bondingCurvePct: params.bondingCurvePct ?? 0,
    })

    return { positionPubkey, txSignature: signature, success: true, positionId }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM] openDammPosition failed:', msg)
    return { positionPubkey: '', txSignature: '', success: false, error: msg }
  }
}

// ── Supabase persist ───────────────────────────────────────────────────────────

async function saveDammPosition({
  params,
  openConfig,
  positionPubkey,
  signature,
  solDeposited,
  entryPriceSol,
  entryPrice,
  dryRun,
}: {
  params: DammPositionParams
  openConfig: ReturnType<typeof getDammOpenConfig>
  positionPubkey: string
  signature: string
  solDeposited: number
  entryPriceSol: number
  entryPrice?: DammSolPrice
  dryRun: boolean
}): Promise<string> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .insert({
      mint: params.tokenAddress,
      symbol: params.symbol,
      pool_address: params.poolAddress,
      position_pubkey: positionPubkey,
      strategy_id: openConfig.strategyId,
      position_type: openConfig.positionType,
      token_amount: 0,
      sol_deposited: solDeposited,
      entry_price_usd: 0,
      entry_price_sol: entryPriceSol,
      status: dryRun ? 'dry_run' : 'active',
      in_range: true,
      dry_run: dryRun,
      opened_at: new Date().toISOString(),
      tx_open: signature,
      metadata: {
        strategy_id: openConfig.strategyId,
        position_type: openConfig.positionType,
        age_minutes: params.ageMinutes,
        fee_tvl_24h_pct: params.feeTvl24hPct,
        liquidity_usd: params.liquidityUsd,
        ...(entryPrice && {
          entry_price_basis: 'sol_per_token',
          entry_price_source: 'damm-v2-sqrt-price-normalized',
          raw_entry_pool_price: entryPrice.poolPrice,
          token_a_mint: entryPrice.tokenAMint,
          token_b_mint: entryPrice.tokenBMint,
          token_a_decimals: entryPrice.tokenADecimals,
          token_b_decimals: entryPrice.tokenBDecimals,
        }),
        ...(params.bondingCurvePct !== undefined && { bonding_curve_pct: params.bondingCurvePct }),
        ...(params.metadata ?? {}),
      },
    })
    .select('id')
    .single()

  if (error) {
    console.error('[DAMM] Failed to persist lp_position:', error.message)
    throw new Error(`[DAMM] Supabase insert failed: ${error.message}`)
  }

  console.log(`[DAMM] lp_position saved: id=${data.id} entry_price_sol=${entryPriceSol} dry_run=${dryRun}`)
  return data.id
}

// ── Close ──────────────────────────────────────────────────────────────────────

/**
 * Close a DAMM v2 position via Zap Out → 100% back to SOL.
 *
 * positionId: Supabase row id from lp_positions.
 * Loads pool_address, position_pubkey, and sol_deposited from DB; no guessing.
 *
 * After the zap-out tx confirms, calls the Meteora DAMM v2 position API with
 * up to 4 retries (1.5s gap) to tolerate post-tx lag. PnL is written to both
 * the top-level realized_pnl_usd column AND metadata for legacy compatibility.
 * Falls back to null if all retries fail — the row is still closed cleanly.
 *
 * Return value now surfaces realizedPnlUsd and totalFeeEarnedUsd so callers
 * (handleDammExit) can include them in Telegram alerts without a second fetch.
 */
export async function closeDammPosition(
  positionId: string,
  reason: string,
): Promise<{
  txSignature: string
  success: boolean
  error?: string
  realizedPnlUsd: number | null
  totalFeeEarnedUsd: number | null
  skipped?: boolean
}> {
  let claimedForClose = false
  let closeTxSignature: string | null = null
  let previousStatus = 'active'
  let previousCloseReason: string | null = null
  let previousMetadata: Record<string, unknown> = {}
  try {
    const supabase = createServerClient()
    const { data: row, error: dbErr } = await supabase
      .from('lp_positions')
      .select('pool_address, position_pubkey, sol_deposited, metadata, dry_run, status, close_reason')
      .eq('id', positionId)
      .single()

    if (dbErr || !row) {
      throw new Error(`[DAMM] lp_position ${positionId} not found: ${dbErr?.message ?? 'null row'}`)
    }

    previousStatus = String(row.status ?? 'active')
    previousCloseReason = typeof row.close_reason === 'string' ? row.close_reason : null
    previousMetadata = (row.metadata as Record<string, unknown>) ?? {}
    if (!CLOSEABLE_DAMM_STATUSES.includes(previousStatus)) {
      const message = `[DAMM] position ${positionId} status=${previousStatus}; close skipped`
      console.warn(message)
      return {
        txSignature: '',
        success: false,
        error: message,
        realizedPnlUsd: null,
        totalFeeEarnedUsd: null,
        skipped: true,
      }
    }

    const closeStartedAt = new Date().toISOString()
    const { data: claimedRows, error: claimErr } = await supabase
      .from('lp_positions')
      .update({
        status: 'pending_close',
        close_reason: reason,
        metadata: {
          ...previousMetadata,
          close_started_at: closeStartedAt,
          close_reason: reason,
        },
      })
      .eq('id', positionId)
      .in('status', CLOSEABLE_DAMM_STATUSES)
      .select('id')

    if (claimErr) {
      throw new Error(`[DAMM] close claim failed for ${positionId}: ${claimErr.message}`)
    }

    if (!claimedRows || claimedRows.length === 0) {
      const message = `[DAMM] position ${positionId} was already claimed or closed; close skipped`
      console.warn(message)
      return {
        txSignature: '',
        success: false,
        error: message,
        realizedPnlUsd: null,
        totalFeeEarnedUsd: null,
        skipped: true,
      }
    }

    claimedForClose = true
    console.log(`[DAMM] Closing position id=${positionId} reason=${reason}`)

    if (row.dry_run === true) {
      const { error: dryRunCloseErr } = await supabase
        .from('lp_positions')
        .update({
          status:       'closed',
          closed_at:    new Date().toISOString(),
          close_reason: reason,
          oor_since_at: null,
          tx_close:     'DRY_RUN',
        })
        .eq('id', positionId)

      if (dryRunCloseErr) {
        throw new Error(`[DAMM] dry_run close DB update failed for ${positionId}: ${dryRunCloseErr.message}`)
      }

      console.log(`[DAMM] dry_run row closed in DB only: ${positionId}`)
      return {
        txSignature: 'DRY_RUN',
        success: true,
        realizedPnlUsd: null,
        totalFeeEarnedUsd: null,
      }
    }

    const zap = await getZap()
    const wallet = getWallet()

    const tx: any = await zap.zapOutThroughDammV2({
      user: wallet.publicKey,
      poolAddress: new PublicKey(row.pool_address),
      inputMint: NATIVE_MINT,
      outputMint: NATIVE_MINT,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_PROGRAM_ID,
      amountIn: new BN(0),
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount: new BN(0),
      percentageToZapOut: 100,
    })

    const resolved = await resolveTransaction(tx)
    const signature = await sendWithPriority(resolved, [wallet], '[DAMM][close]')
    closeTxSignature = signature

    // ── Realized PnL — 4× retry to survive Meteora API lag ────────────────
    const pnlData = await fetchDammPositionPnlWithRetry(row.position_pubkey)
    if (pnlData) {
      console.log(`[DAMM] Realized PnL: $${pnlData.realized_pnl_usd} | fees: $${pnlData.total_fee_earned_usd}`)
    } else {
      console.warn('[DAMM] realized_pnl_usd will be null — all PnL API retries failed')
    }

    // Merge into existing metadata; preserve open-time fields (age_minutes etc).
    const existingMeta = (row.metadata as Record<string, unknown>) ?? {}
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      ...(pnlData !== null && {
        realized_pnl_usd:     pnlData.realized_pnl_usd,
        total_fee_earned_usd: pnlData.total_fee_earned_usd,
      }),
    }

    const { error: closeUpdateErr } = await supabase
      .from('lp_positions')
      .update({
        status:           'closed',
        closed_at:        new Date().toISOString(),
        close_reason:     reason,
        oor_since_at:     null,
        tx_close:         signature,
        metadata:         updatedMeta,
        // Top-level column — written alongside metadata for dashboard queries
        ...(pnlData !== null && { realized_pnl_usd: pnlData.realized_pnl_usd }),
      })
      .eq('id', positionId)

    if (closeUpdateErr) {
      throw new Error(`[DAMM] close DB update failed after tx ${signature}: ${closeUpdateErr.message}`)
    }

    console.log(`[DAMM] ✅ Closed via Zap Out: ${signature}`)
    return {
      txSignature: signature,
      success: true,
      realizedPnlUsd:    pnlData?.realized_pnl_usd    ?? null,
      totalFeeEarnedUsd: pnlData?.total_fee_earned_usd ?? null,
    }
  } catch (e: any) {
    const msg = summarizeError(e)
    console.error('[DAMM] closeDammPosition failed:', msg)
    if (claimedForClose && !closeTxSignature) {
      const supabase = createServerClient()
      const { error: restoreErr } = await supabase
        .from('lp_positions')
        .update({
          status: previousStatus,
          close_reason: previousCloseReason,
          metadata: {
            ...previousMetadata,
            close_failed_at: new Date().toISOString(),
            close_error: msg,
          },
        })
        .eq('id', positionId)

      if (restoreErr) {
        console.error(`[DAMM] failed to restore ${positionId} after close failure: ${restoreErr.message}`)
      }
    }
    return { txSignature: '', success: false, error: msg, realizedPnlUsd: null, totalFeeEarnedUsd: null }
  }
}

// ── Pool config helper ──────────────────────────────────────────────────────────

export async function getDammPoolConfig(poolAddress: string): Promise<{
  isValid: boolean
  currentPrice?: number
  feePct?: number
}> {
  try {
    const sdk = await getCpAmm()
    const pool = await sdk.fetchPoolState(new PublicKey(poolAddress))
    if (!pool) return { isValid: false }
    const price = await getDammSolPriceFromPoolState(getConnection(), pool)
    return {
      isValid: true,
      currentPrice: price?.solPerToken,
      feePct: pool.poolFees?.baseFactor ? Number(pool.poolFees.baseFactor) / 100 : undefined,
    }
  } catch {
    return { isValid: false }
  }
}
