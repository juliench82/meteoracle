/**
 * bot/damm-executor.ts — FULL PRODUCTION DAMM v2 Executor
 *
 * - Real open:  createPosition + addLiquidity via @meteora-ag/cp-amm-sdk
 * - Real close: zapOutThroughDammV2 via @meteora-ag/zap-sdk → everything to SOL
 * - Wallet:     loaded from WALLET_PRIVATE_KEY env (base58), never from PublicKey alone
 * - Lazy imports: all SDK imports are dynamic to prevent Next.js build-time IDL crash
 *
 * ISOLATION RULE: Must NOT import from bot/executor.ts or bot/monitor.ts.
 */

import { Connection, PublicKey, Keypair, sendAndConfirmTransaction, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import bs58 from 'bs58'
import type { DammPositionParams } from '@/lib/types'

// ── Lazy singleton helpers ─────────────────────────────────────────────────────
// All SDK instantiation is deferred to first call-time.
// This prevents module-level evaluation during Next.js build (which would
// trigger Anchor IDL parsing and crash page-data collection).

let _connection: Connection | null = null
let _cpAmm: any = null
let _zap:  any = null

function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL!, 'confirmed')
  }
  return _connection
}

/** Load the bot wallet from WALLET_PRIVATE_KEY (base58-encoded secret key). */
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

/**
 * Some Meteora SDK methods return a TxBuilder (with a .build() method) rather
 * than a raw Transaction. This helper handles both cases transparently.
 */
async function resolveTransaction(txOrBuilder: any): Promise<Transaction> {
  if (txOrBuilder && typeof txOrBuilder.build === 'function') {
    return txOrBuilder.build()
  }
  return txOrBuilder as Transaction
}

// ── Open ───────────────────────────────────────────────────────────────────────

/**
 * Open a DAMM v2 position for the given token/pool.
 *
 * Flow:
 *   1. Fetch pool state to confirm live + detect which side is SOL.
 *   2. Create a fresh position Keypair.
 *   3. Call createPosition, then addLiquidity (single-sided SOL input).
 *   4. Return position pubkey + tx signature for Supabase recording.
 */
export async function openDammPosition(
  params: DammPositionParams
): Promise<{ positionPubkey: string; txSignature: string; success: boolean; error?: string }> {
  console.log(`[DAMM] Opening position — pool=${params.poolAddress} sol=${params.solAmount}`)

  try {
    const sdk    = await getCpAmm()
    const wallet = getWallet()
    const pool   = new PublicKey(params.poolAddress)
    const positionKp = Keypair.generate()

    // 1. Confirm pool is live
    const poolState = await sdk.fetchPoolState(pool)
    if (!poolState) throw new Error('Pool not found or paused')

    // 2. Single-sided SOL deposit — determine which token mint is SOL
    const WSOL = 'So11111111111111111111111111111111111111112'
    const solLamports = Math.floor(params.solAmount * 1e9)
    const isTokenASol = poolState.tokenAMint.toBase58() === WSOL
    const tokenAAmountIn = new BN(isTokenASol ? solLamports : 0)
    const tokenBAmountIn = new BN(isTokenASol ? 0 : solLamports)

    // 3. Create position account
    const createRaw = await sdk.createPosition({
      owner:    wallet.publicKey,
      pool,
      position: positionKp.publicKey,
    })
    const createTx = await resolveTransaction(createRaw)
    await sendAndConfirmTransaction(getConnection(), createTx, [wallet, positionKp], {
      commitment: 'confirmed',
    })
    console.log(`[DAMM] Position account created: ${positionKp.publicKey.toBase58()}`)

    // 4. Add single-sided liquidity
    const addRaw = await sdk.addLiquidity({
      owner:           wallet.publicKey,
      pool,
      position:        positionKp.publicKey,
      tokenAAmountIn,
      tokenBAmountIn,
      liquidityMin:    new BN(0),   // no slippage protection for now — tighten once live
    })
    const addTx = await resolveTransaction(addRaw)
    const signature = await sendAndConfirmTransaction(getConnection(), addTx, [wallet], {
      commitment: 'confirmed',
    })

    console.log(`[DAMM] ✅ Opened: ${signature}`)
    return { positionPubkey: positionKp.publicKey.toBase58(), txSignature: signature, success: true }

  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM] openDammPosition failed:', msg)
    return { positionPubkey: '', txSignature: '', success: false, error: msg }
  }
}

// ── Close ──────────────────────────────────────────────────────────────────────

/**
 * Close a DAMM v2 position via Zap Out → 100% back to SOL.
 *
 * poolAddress must be supplied (stored in lp_positions.pool_address when opened).
 * Without it we cannot build the zap-out instruction.
 */
export async function closeDammPosition(
  positionPubkey: string,
  reason: string,
  poolAddress: string,
): Promise<{ txSignature: string; success: boolean; error?: string }> {
  console.log(`[DAMM] Closing via Zap Out: ${positionPubkey} — ${reason}`)

  try {
    const zap    = await getZap()
    const wallet = getWallet()
    const WSOL   = new PublicKey('So11111111111111111111111111111111111111112')
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

    const tx: any = await zap.zapOutThroughDammV2({
      user:                wallet.publicKey,
      poolAddress:         new PublicKey(poolAddress),
      inputMint:           WSOL,
      outputMint:          WSOL,
      inputTokenProgram:   TOKEN_PROGRAM,
      outputTokenProgram:  TOKEN_PROGRAM,
      amountIn:            new BN(0),
      minimumSwapAmountOut: new BN(0),
      maxSwapAmount:       new BN(0),
      percentageToZapOut:  100,
    })

    const resolved = await resolveTransaction(tx)
    const signature = await sendAndConfirmTransaction(getConnection(), resolved, [wallet], {
      commitment: 'confirmed',
    })

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
  isValid:       boolean
  currentPrice?: number
  feePct?:       number
}> {
  try {
    const sdk  = await getCpAmm()
    const pool = await sdk.fetchPoolState(new PublicKey(poolAddress))
    if (!pool) return { isValid: false }
    return {
      isValid:      true,
      currentPrice: Number(pool.sqrtPrice ?? 0),
      feePct:       pool.poolFees?.baseFactor ? Number(pool.poolFees.baseFactor) / 100 : undefined,
    }
  } catch {
    return { isValid: false }
  }
}
