/**
 * lp-migrator.ts  — Day 7
 *
 * Polls spot_positions for tokens that have graduated (graduated=true, lp_migrated=false).
 * Also polls open spot positions to detect new graduations via pump.fun API.
 *
 * For each graduated token:
 *   1. Checks if Meteora has created a DLMM pool for the mint
 *   2. Retries until pool appears or timeout expires
 *   3. Deposits LP_BAG_PCT % of token bag into the Meteora DLMM pool
 *   4. Writes lp_positions row, marks spot_positions.lp_migrated = true
 *   5. Fires Telegram alert
 *
 * BOT_DRY_RUN=true  → simulates LP open, no on-chain tx
 * BOT_DRY_RUN=false → real DLMM deposit
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import DLMM, { StrategyType } from '@meteora-ag/dlmm'
import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendTelegram } from './telegram'
import { POST_GRAD_LP_STRATEGY } from '../strategies/post-grad-lp'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const POLL_INTERVAL = 60_000   // check for new graduations every 60s
const cfg           = POST_GRAD_LP_STRATEGY

console.log(`[lp-migrator] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[lp-migrator] LP_BAG_PCT=${cfg.lp.bagPct}% | binsDown=${cfg.lp.binsDown} | binsUp=${cfg.lp.binsUp}`)
console.log(`[lp-migrator] pool search timeout=${cfg.poolSearchTimeoutMin}min | retry=${cfg.poolSearchRetrySeconds}s`)

// ─── pump.fun graduation check ───────────────────────────────────────────────

interface PumpToken {
  complete:          boolean
  bonding_curve_pct: number
  raydium_pool?:     string
}

async function fetchPumpToken(mint: string): Promise<PumpToken | null> {
  try {
    const res = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 8_000 })
    return res.data ?? null
  } catch {
    return null
  }
}

// ─── Meteora pool discovery ───────────────────────────────────────────────────

async function findMeteoraPool(mint: string): Promise<string | null> {
  try {
    // Meteora's public pool search API — returns pools that include this token
    const res = await axios.get('https://dlmm-api.meteora.ag/pair/all_with_pagination', {
      params: { token: mint, limit: 5, sort_key: 'tvl', order_by: 'desc' },
      timeout: 10_000,
    })
    const pairs = res.data?.data ?? res.data?.pairs ?? []
    if (pairs.length === 0) return null
    // Prefer SOL pair
    const solPair = pairs.find((p: any) =>
      p.mint_x === mint && p.mint_y === 'So11111111111111111111111111111111111111112' ||
      p.mint_y === mint && p.mint_x === 'So11111111111111111111111111111111111111112'
    )
    return (solPair ?? pairs[0])?.address ?? null
  } catch {
    return null
  }
}

// ─── Wait for pool with retry ─────────────────────────────────────────────────

async function waitForMeteoraPool(
  mint:   string,
  symbol: string,
): Promise<string | null> {
  const deadline  = Date.now() + cfg.poolSearchTimeoutMin * 60_000
  const retryMs   = cfg.poolSearchRetrySeconds * 1_000
  let   attempt   = 0

  while (Date.now() < deadline) {
    attempt++
    const pool = await findMeteoraPool(mint)
    if (pool) {
      console.log(`[lp-migrator] [${symbol}] Meteora pool found: ${pool} (attempt ${attempt})`)
      return pool
    }
    console.log(`[lp-migrator] [${symbol}] pool not yet listed — retry in ${cfg.poolSearchRetrySeconds}s (attempt ${attempt})`)
    await new Promise(r => setTimeout(r, retryMs))
  }

  console.warn(`[lp-migrator] [${symbol}] pool search timed out after ${cfg.poolSearchTimeoutMin}min`)
  return null
}

// ─── DLMM deposit ────────────────────────────────────────────────────────────

async function openLpPosition(
  spotPositionId: string,
  mint:           string,
  symbol:         string,
  tokenAmount:    number,
  tokenDecimals:  number,
  poolAddress:    string,
  isDryRun:       boolean,
): Promise<void> {
  const label   = `[lp-migrator][${symbol}]`
  const supabase = createServerClient()

  const lpTokens = Math.floor(tokenAmount * (cfg.lp.bagPct / 100))
  console.log(`${label} deploying ${lpTokens} tokens (${cfg.lp.bagPct}% of ${tokenAmount}) into LP`)

  if (isDryRun) {
    console.log(`${label} DRY RUN — skipping on-chain DLMM deposit`)
    const { data: inserted } = await supabase.from('lp_positions').insert({
      spot_position_id: spotPositionId,
      mint, symbol, pool_address: poolAddress,
      token_amount:     lpTokens,
      sol_deposited:    0,
      entry_price_usd:  0,
      status:           'active',
      dry_run:          true,
      tx_open:          'dry-run',
      metadata:         { note: 'dry-run LP open' },
    }).select('id').single()

    await supabase.from('spot_positions').update({ lp_migrated: true }).eq('id', spotPositionId)
    await sendTelegram(
      `🟡 [DRY-RUN] LP OPENED ${symbol}\n` +
      `📦 Tokens in LP: ${lpTokens.toLocaleString()} (${cfg.lp.bagPct}% of bag)\n` +
      `🏊 Pool: ${poolAddress.slice(0, 8)}...`
    )
    console.log(`${label} dry-run LP row inserted: ${inserted?.id}`)
    return
  }

  const connection = getConnection()
  const wallet     = getWallet()

  try {
    const dlmmPool   = await DLMM.create(connection, new PublicKey(poolAddress))
    const activeBin  = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId
    const binStep    = dlmmPool.lbPair.binStep

    const minBinId   = activeBinId - cfg.lp.binsDown
    const maxBinId   = activeBinId + cfg.lp.binsUp
    console.log(`${label} bin range ${minBinId}→${maxBinId} (step=${binStep})`)

    // Determine which side is the token vs SOL
    const mintX      = dlmmPool.tokenX.publicKey.toBase58()
    const WSOL       = 'So11111111111111111111111111111111111111112'
    const tokenIsX   = mintX === mint

    const rawTokenUnits = new BN(lpTokens).mul(new BN(10 ** tokenDecimals))
    const totalX     = tokenIsX ? rawTokenUnits : new BN(0)
    const totalY     = tokenIsX ? new BN(0)      : rawTokenUnits

    // Ensure token ATA exists
    const tokenProgram = await (async () => {
      const info = await connection.getAccountInfo(new PublicKey(mint))
      return info?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    })()
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID)
    const ataInfo = await connection.getAccountInfo(ata)
    if (!ataInfo) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, new PublicKey(mint), tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID)
      )
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      ataTx.recentBlockhash = blockhash
      ataTx.feePayer = wallet.publicKey
      ataTx.sign(wallet)
      const ataSig = await connection.sendRawTransaction(ataTx.serialize())
      await connection.confirmTransaction({ signature: ataSig, blockhash, lastValidBlockHeight }, 'confirmed')
      console.log(`${label} ATA created ✔`)
    }

    const strategyTypeMap: Record<string, StrategyType> = {
      spot: StrategyType.Spot, curve: StrategyType.Curve, 'bid-ask': StrategyType.BidAsk,
    }
    const strategyType = strategyTypeMap[cfg.lp.distributionType] ?? StrategyType.Spot

    const priorityFee = await getPriorityFee([poolAddress, wallet.publicKey.toBase58()])

    const response = await dlmmPool.initializeMultiplePositionAndAddLiquidityByStrategy(
      async (count) => Array.from({ length: count }, () => new Keypair()),
      totalX, totalY,
      { minBinId, maxBinId, strategyType },
      wallet.publicKey,
      wallet.publicKey,
      1
    )

    let lastSig = ''
    let positionPubkey = ''
    for (const { positionKeypair, initializePositionIx, addLiquidityIxs } of response.instructionsByPositions) {
      positionPubkey = positionKeypair.publicKey.toBase58()
      const initIxs  = Array.isArray(initializePositionIx) ? initializePositionIx : [initializePositionIx]
      const initTx   = new Transaction().add(...initIxs)
      const { blockhash: bh1, lastValidBlockHeight: lbh1 } = await connection.getLatestBlockhash('confirmed')
      initTx.recentBlockhash = bh1; initTx.feePayer = wallet.publicKey
      initTx.sign(wallet, positionKeypair)
      lastSig = await connection.sendRawTransaction(initTx.serialize())
      await connection.confirmTransaction({ signature: lastSig, blockhash: bh1, lastValidBlockHeight: lbh1 }, 'confirmed')

      const liqChunks = Array.isArray(addLiquidityIxs) ? addLiquidityIxs.map((ix: any) => Array.isArray(ix) ? ix : [ix]) : [[addLiquidityIxs]]
      for (const chunk of liqChunks) {
        const liqTx = new Transaction().add(...chunk)
        const { blockhash: bh2, lastValidBlockHeight: lbh2 } = await connection.getLatestBlockhash('confirmed')
        liqTx.recentBlockhash = bh2; liqTx.feePayer = wallet.publicKey
        liqTx.sign(wallet)
        lastSig = await connection.sendRawTransaction(liqTx.serialize())
        await connection.confirmTransaction({ signature: lastSig, blockhash: bh2, lastValidBlockHeight: lbh2 }, 'confirmed')
      }
    }
    console.log(`${label} LP opened ✔ sig: ${lastSig}`)

    // Current price for entry_price_usd
    let entryPriceUsd = 0
    try {
      const priceRes = await axios.get('https://api.jup.ag/price/v2', { params: { ids: mint }, timeout: 8_000 })
      entryPriceUsd = parseFloat(priceRes.data?.data?.[mint]?.price ?? '0')
    } catch {}

    await supabase.from('lp_positions').insert({
      spot_position_id: spotPositionId,
      mint, symbol, pool_address: poolAddress,
      position_pubkey:  positionPubkey,
      token_amount:     lpTokens,
      sol_deposited:    0,
      bin_lower:        minBinId,
      bin_upper:        maxBinId,
      entry_bin:        activeBinId,
      entry_price_usd:  entryPriceUsd,
      status:           'active',
      dry_run:          false,
      tx_open:          lastSig,
    })

    await supabase.from('spot_positions').update({ lp_migrated: true }).eq('id', spotPositionId)

    await sendTelegram(
      `🟢 LP OPENED ${symbol}\n` +
      `📦 Tokens in LP: ${lpTokens.toLocaleString()} (${cfg.lp.bagPct}% of bag)\n` +
      `📊 Bins: ${minBinId}→${maxBinId} | entry bin: ${activeBinId}\n` +
      `💵 Entry: $${entryPriceUsd.toExponential(4)}\n` +
      `🔗 https://solscan.io/tx/${lastSig}`
    )

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${label} LP open failed:`, msg)
    await supabase.from('bot_logs').insert({
      level: 'error', event: 'lp_open_failed',
      payload: { spotPositionId, mint, symbol, error: msg },
    })
    await sendTelegram(`❌ LP OPEN FAILED ${symbol}\n${msg}`)
  }
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const supabase = createServerClient()

  // 1. Check open spot positions for new graduations
  const { data: openSpots } = await supabase
    .from('spot_positions')
    .select('id, mint, symbol, token_amount, dry_run')
    .eq('status', 'open')
    .eq('graduated', false)

  for (const spot of (openSpots ?? [])) {
    const token = await fetchPumpToken(spot.mint)
    if (!token?.complete) continue

    console.log(`[lp-migrator] 🎓 ${spot.symbol} graduated! marking + queuing LP migration`)
    await supabase.from('spot_positions').update({
      graduated:    true,
      graduated_at: new Date().toISOString(),
    }).eq('id', spot.id)
    await sendTelegram(`🎓 ${spot.symbol} GRADUATED!\nSearching for Meteora pool...`)
  }

  // 2. Pick up graduated-but-not-yet-migrated positions
  const { data: toMigrate } = await supabase
    .from('spot_positions')
    .select('id, mint, symbol, token_amount, dry_run')
    .eq('graduated',   true)
    .eq('lp_migrated', false)
    .in('status', ['open', 'closed_tp', 'closed_sl'])  // migrate even if spot already exited

  for (const spot of (toMigrate ?? [])) {
    if (!spot.token_amount || spot.token_amount <= 0) {
      console.warn(`[lp-migrator] [${spot.symbol}] token_amount=0 — skipping LP`)
      await supabase.from('spot_positions').update({ lp_migrated: true }).eq('id', spot.id)
      continue
    }

    console.log(`[lp-migrator] searching for Meteora pool for ${spot.symbol} (${spot.mint.slice(0, 8)}...)`)
    const poolAddress = await waitForMeteoraPool(spot.mint, spot.symbol)

    if (!poolAddress) {
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'lp_pool_not_found',
        payload: { mint: spot.mint, symbol: spot.symbol },
      })
      await sendTelegram(`⚠️ No Meteora pool found for ${spot.symbol} after ${cfg.poolSearchTimeoutMin}min — skipping LP`)
      await supabase.from('spot_positions').update({ lp_migrated: true }).eq('id', spot.id)  // don't retry forever
      continue
    }

    await openLpPosition(
      spot.id,
      spot.mint,
      spot.symbol,
      spot.token_amount,
      6,  // pump.fun tokens are always 6 decimals
      poolAddress,
      DRY_RUN || spot.dry_run,
    )
  }
}

async function main(): Promise<void> {
  await tick()
  setInterval(tick, POLL_INTERVAL)
}

main().catch(err => {
  console.error('[lp-migrator] fatal:', err)
  process.exit(1)
})
