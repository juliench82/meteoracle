/**
 * bot/damm-executor.ts — FULL PRODUCTION DAMM v2 Executor
 *
 * - Real open:  createPositionAndAddLiquidity via @meteora-ag/cp-amm-sdk
 *   Uses single-sided SOL deposit: maxAmountToken[A|B] = lamports, other side = 0.
 *   liquidityDelta computed via sdk.getDepositQuote().
 *   Saves to lp_positions with strategy_id = 'damm-edge'.
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
import type { DammPositionParams } from '@/lib/types'
import { getBotState } from '@/lib/botState'
import { createServerClient } from '@/lib/supabase'
import { assertCanOpenLpPosition } from '@/lib/position-limits'
import { sendAlert } from './alerter'

const METEORA_DAMM_API = 'https://amm-v2.meteora.ag'
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

// ── Lazy singleton helpers ─────────────────────────────────────────────────────

let _connection: Connection | null = null
let _cpAmm: any = null
let _zap: any = null

function getRpcUrl(): string {
  const heliusFromKey = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : ''
  const url = process.env.RPC_URL || process.env.HELIUS_RPC_URL || heliusFromKey
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

async function getCpAmm(): Promise<any> {
  if (!_cpAmm) {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')
    _cpAmm = new CpAmm(getConnection())
  }
  return _cpAmm
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

/** Convert Q64.64 sqrtPrice BN → SOL-denominated price ratio. */
function sqrtPriceToSol(sqrtPrice: BN): number {
  const ratio = Number(sqrtPrice.toString()) / 2 ** 64
  return ratio * ratio
}

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
      console.warn(`[DAMM] PnL API attempt ${attempt}/${ATTEMPTS} threw:`, e)
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
 *   7. Persist to lp_positions with strategy_id = 'damm-edge'.
 *      entry_price_sol is captured from sqrtPrice at open so TP/SL have a baseline.
 *   8. Fire pre_grad_opened Telegram alert.
 */
export async function openDammPosition(
  params: DammPositionParams,
): Promise<{ positionPubkey: string; txSignature: string; success: boolean; error?: string }> {
  console.log(`[DAMM] Opening position — pool=${params.poolAddress} sol=${params.solAmount}`)

  try {
    // 1. dry_run guard — match DLMM bot_state + BOT_DRY_RUN behavior
    const dryRun = await getBotDryRun()
    console.log(`[DAMM] dry_run=${dryRun}`)

    if (dryRun) {
      const positionId = await saveDammPosition({
        params,
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
      return { positionPubkey: positionId, txSignature: 'DRY_RUN', success: true }
    }

    const limitState = await assertCanOpenLpPosition(MAX_CONCURRENT_POSITIONS, '[DAMM]')
    console.log(
      `[DAMM] LP cap ok (${limitState.effectiveOpenCount}/${MAX_CONCURRENT_POSITIONS}; ` +
      `live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount})`,
    )

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

    // Capture entry price from sqrtPrice at the moment of open
    const entryPriceSol = sqrtPriceToSol(sqrtPrice)

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

    // 6. Persist — entry_price_sol written from live sqrtPrice, dry_run from bot_state
    const positionId = await saveDammPosition({
      params,
      positionPubkey,
      signature,
      solDeposited: params.solAmount,
      entryPriceSol,
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

    return { positionPubkey, txSignature: signature, success: true }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM] openDammPosition failed:', msg)
    return { positionPubkey: '', txSignature: '', success: false, error: msg }
  }
}

// ── Supabase persist ───────────────────────────────────────────────────────────

async function saveDammPosition({
  params,
  positionPubkey,
  signature,
  solDeposited,
  entryPriceSol,
  dryRun,
}: {
  params: DammPositionParams
  positionPubkey: string
  signature: string
  solDeposited: number
  entryPriceSol: number
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
      strategy_id: 'damm-edge',
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
        age_minutes: params.ageMinutes,
        fee_tvl_24h_pct: params.feeTvl24hPct,
        liquidity_usd: params.liquidityUsd,
        ...(params.bondingCurvePct !== undefined && { bonding_curve_pct: params.bondingCurvePct }),
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
}> {
  console.log(`[DAMM] Closing position id=${positionId} reason=${reason}`)

  try {
    const supabase = createServerClient()
    const { data: row, error: dbErr } = await supabase
      .from('lp_positions')
      .select('pool_address, position_pubkey, sol_deposited, metadata, dry_run')
      .eq('id', positionId)
      .single()

    if (dbErr || !row) {
      throw new Error(`[DAMM] lp_position ${positionId} not found: ${dbErr?.message ?? 'null row'}`)
    }

    if (row.dry_run === true) {
      await supabase
        .from('lp_positions')
        .update({
          status:       'closed',
          closed_at:    new Date().toISOString(),
          close_reason: reason,
          oor_since_at: null,
          tx_close:     'DRY_RUN',
        })
        .eq('id', positionId)

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

    await supabase
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

    console.log(`[DAMM] ✅ Closed via Zap Out: ${signature}`)
    return {
      txSignature: signature,
      success: true,
      realizedPnlUsd:    pnlData?.realized_pnl_usd    ?? null,
      totalFeeEarnedUsd: pnlData?.total_fee_earned_usd ?? null,
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM] closeDammPosition failed:', msg)
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
    return {
      isValid: true,
      currentPrice: sqrtPriceToSol(pool.sqrtPrice),
      feePct: pool.poolFees?.baseFactor ? Number(pool.poolFees.baseFactor) / 100 : undefined,
    }
  } catch {
    return { isValid: false }
  }
}
