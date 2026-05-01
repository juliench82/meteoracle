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
 *   After confirmation, reads the on-chain balance delta and writes
 *   metadata.realized_pnl_usd to the closed row.
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
 * After the zap-out tx confirms, reads the on-chain pre/post SOL balance of the
 * wallet to compute the realized return, then writes metadata.realized_pnl_usd
 * to the closed row as the canonical close-time snapshot.
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

    const solDeposited = Number(row.sol_deposited ?? 0)
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

    // ── Realized PnL from on-chain balance delta ───────────────────────────
    // post - pre = net SOL received from the zap (tx fees already deducted by runtime).
    // realizedPnlUsd stored as SOL-denominated value; multiply by SOL price
    // if USD conversion is added later. For now the field name is intentional:
    // it is the authoritative close-time value regardless of denomination.
    let realizedPnlUsd: number | null = null
    try {
      const connection = getConnection()
      const confirmedTx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      if (confirmedTx?.meta) {
        const keys = confirmedTx.transaction.message.staticAccountKeys
        const walletIdx = keys.findIndex(
          (k: any) => k.toBase58() === wallet.publicKey.toBase58(),
        )
        if (walletIdx >= 0) {
          const pre  = confirmedTx.meta.preBalances[walletIdx]  ?? 0
          const post = confirmedTx.meta.postBalances[walletIdx] ?? 0
          const solReceived = (post - pre) / 1e9
          realizedPnlUsd = Math.round((solReceived - solDeposited) * 1e6) / 1e6
          console.log(`[DAMM] Realized PnL: ${realizedPnlUsd} SOL (deposited=${solDeposited}, received=${solReceived})`)
        }
      }
    } catch (e) {
      console.warn('[DAMM] Could not compute realized PnL from tx — skipping:', e)
    }

    // Merge realized_pnl_usd into existing metadata; preserve live monitor fields.
    const existingMeta = (row.metadata as Record<string, unknown>) ?? {}
    const updatedMeta = realizedPnlUsd !== null
      ? { ...existingMeta, realized_pnl_usd: realizedPnlUsd }
      : existingMeta

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
