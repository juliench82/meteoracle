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
 *   After confirmation, fetches Meteora DAMM v2 position API for authoritative
 *   USD PnL and writes metadata.realized_pnl_usd to the closed row.
 *
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
import { createServerClient } from '@/lib/supabase'
import { sendAlert } from './alerter'

const METEORA_DAMM_API = 'https://amm-v2.meteora.ag'

// ── Lazy singleton helpers ─────────────────────────────────────────────────────

let _connection: Connection | null = null
let _cpAmm: any = null
let _zap: any = null

function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL!, 'confirmed')
  }
  return _connection
}

function getWallet(): Keypair {
  const key = process.env.WALLET_PRIVATE_KEY
  if (!key) throw new Error('[DAMM] WALLET_PRIVATE_KEY not set')
  return Keypair.fromSecretKey(bs58.decode(key))
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
  const TWO_POW_64 = 2n ** 64n
  const sp = BigInt(sqrtPrice.toString())
  return Number((sp * sp) / (TWO_POW_64 * TWO_POW_64))
}

/**
 * Fetch realized PnL (USD) from the Meteora DAMM v2 position API.
 * Returns null if the request fails — caller falls back to null gracefully.
 *
 * Response shape (relevant fields):
 *   { position_pnl_usd: number, total_fee_earned_usd: number, ... }
 */
async function fetchDammPositionPnl(positionPubkey: string): Promise<{
  realized_pnl_usd: number
  total_fee_earned_usd: number
} | null> {
  try {
    const res = await fetch(`${METEORA_DAMM_API}/position/${positionPubkey}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.warn(`[DAMM] Meteora position API ${res.status} for ${positionPubkey}`)
      return null
    }
    const json = await res.json()
    const realized_pnl_usd    = Number(json?.position_pnl_usd    ?? json?.pnl_usd    ?? NaN)
    const total_fee_earned_usd = Number(json?.total_fee_earned_usd ?? json?.fee_earned_usd ?? NaN)
    if (isNaN(realized_pnl_usd)) {
      console.warn('[DAMM] Meteora API response missing position_pnl_usd:', JSON.stringify(json).slice(0, 200))
      return null
    }
    return { realized_pnl_usd, total_fee_earned_usd: isNaN(total_fee_earned_usd) ? 0 : total_fee_earned_usd }
  } catch (e) {
    console.warn('[DAMM] fetchDammPositionPnl failed:', e)
    return null
  }
}

// ── Open ───────────────────────────────────────────────────────────────────────

/**
 * Open a DAMM v2 position for the given token/pool.
 *
 * Flow:
 *   1. Fetch pool state to get sqrtPrice, vaults, mints, programs, collectFeeMode.
 *   2. Determine which side is SOL; build maxAmountToken[A|B].
 *   3. Compute liquidityDelta via sdk.getDepositQuote() for single-sided deposit.
 *   4. Generate fresh position NFT Keypair.
 *   5. Call sdk.createPositionAndAddLiquidity() → build → sign → confirm.
 *   6. Persist to lp_positions with strategy_id = 'damm-edge'.
 *      entry_price_sol is captured from sqrtPrice at open so TP/SL have a baseline.
 *   7. Fire pre_grad_opened Telegram alert.
 */
export async function openDammPosition(
  params: DammPositionParams,
): Promise<{ positionPubkey: string; txSignature: string; success: boolean; error?: string }> {
  console.log(`[DAMM] Opening position — pool=${params.poolAddress} sol=${params.solAmount}`)

  try {
    const sdk = await getCpAmm()
    const wallet = getWallet()
    const pool = new PublicKey(params.poolAddress)
    const positionNftKp = Keypair.generate()

    // 1. Fetch pool state
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

    // 2. Token programs — tokenFlag: 0 = SPL, 1 = Token2022
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

    // 3. Compute liquidityDelta for single-sided deposit
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

    // 4. createPositionAndAddLiquidity
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

    // 5. Persist — entry_price_sol written from live sqrtPrice
    const positionId = await saveDammPosition({
      params,
      positionPubkey,
      signature,
      solDeposited: params.solAmount,
      entryPriceSol,
    })

    // 6. Fire Telegram alert
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
}: {
  params: DammPositionParams
  positionPubkey: string
  signature: string
  solDeposited: number
  entryPriceSol: number
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
      status: 'active',
      in_range: true,
      dry_run: process.env.BOT_DRY_RUN === 'true',
      opened_at: new Date().toISOString(),
      tx_open: signature,
      metadata: {
        age_minutes: params.ageMinutes,
        fee_tvl_24h_pct: params.feeTvl24hPct,
        liquidity_usd: params.liquidityUsd,
      },
    })
    .select('id')
    .single()

  if (error) {
    console.error('[DAMM] Failed to persist lp_position:', error.message)
    throw new Error(`[DAMM] Supabase insert failed: ${error.message}`)
  }

  console.log(`[DAMM] lp_position saved: id=${data.id} entry_price_sol=${entryPriceSol}`)
  return data.id
}

// ── Close ──────────────────────────────────────────────────────────────────────

/**
 * Close a DAMM v2 position via Zap Out → 100% back to SOL.
 *
 * positionId: Supabase row id from lp_positions.
 * Loads pool_address, position_pubkey, and sol_deposited from DB; no guessing.
 *
 * After the zap-out tx confirms, calls the Meteora DAMM v2 position API to get
 * the authoritative USD PnL and writes metadata.realized_pnl_usd to the closed row.
 * Falls back to null if the API is unreachable — the row is still closed cleanly.
 */
export async function closeDammPosition(
  positionId: string,
  reason: string,
): Promise<{ txSignature: string; success: boolean; error?: string }> {
  console.log(`[DAMM] Closing position id=${positionId} reason=${reason}`)

  try {
    const supabase = createServerClient()
    const { data: row, error: dbErr } = await supabase
      .from('lp_positions')
      .select('pool_address, position_pubkey, sol_deposited, metadata')
      .eq('id', positionId)
      .single()

    if (dbErr || !row) {
      throw new Error(`[DAMM] lp_position ${positionId} not found: ${dbErr?.message ?? 'null row'}`)
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

    // ── Realized PnL from Meteora DAMM v2 API ─────────────────────────────
    // The position may take a few seconds to settle on the API after the tx;
    // a single attempt is sufficient — if it fails we still close cleanly.
    const pnlData = await fetchDammPositionPnl(row.position_pubkey)
    if (pnlData) {
      console.log(`[DAMM] Realized PnL (Meteora API): $${pnlData.realized_pnl_usd} | fees: $${pnlData.total_fee_earned_usd}`)
    } else {
      console.warn('[DAMM] Could not fetch realized PnL from Meteora API — metadata.realized_pnl_usd will be null')
    }

    // Merge into existing metadata; preserve open-time fields (age_minutes etc).
    const existingMeta = (row.metadata as Record<string, unknown>) ?? {}
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      ...(pnlData !== null && {
        realized_pnl_usd:    pnlData.realized_pnl_usd,
        total_fee_earned_usd: pnlData.total_fee_earned_usd,
      }),
    }

    await supabase
      .from('lp_positions')
      .update({
        status:       'closed',
        closed_at:    new Date().toISOString(),
        close_reason: reason,
        oor_since_at: null,
        tx_close:     signature,
        metadata:     updatedMeta,
      })
      .eq('id', positionId)

    console.log(`[DAMM] ✅ Closed via Zap Out: ${signature}`)
    return { txSignature: signature, success: true }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM] closeDammPosition failed:', msg)
    return { txSignature: '', success: false, error: msg }
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
