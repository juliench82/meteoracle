/**
 * spot-buyer.ts
 *
 * Reads pre_grad_watchlist, buys qualifying tokens via Jupiter v6, and stores
 * positions in spot_positions.
 *
 * BOT_DRY_RUN=true  (default) — logs only, no real transactions
 * BOT_DRY_RUN=false           — live mode, REAL money
 *
 * SOL budget guards (both dry-run and live):
 *   MAX_CONCURRENT_SPOTS  — max open positions
 *   MAX_TOTAL_SPOT_SOL    — max SOL deployed in spots
 *   SOL_RESERVE           — SOL kept back for LP bin rent + tx fees (never spent on spots)
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { sendTelegram } from './telegram'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const RPC_URL       = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const JUPITER_API   = 'https://quote-api.jup.ag/v6'
const WSOL_MINT     = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS  = parseInt(process.env.SPOT_BUY_SLIPPAGE_BPS ?? '300')
const POLL_INTERVAL = parseInt(process.env.SPOT_BUYER_POLL_SEC   ?? '30') * 1_000

// Minimum wallet balance kept in reserve for LP bin rent + tx fees.
// SOL_RESERVE takes precedence over MIN_WALLET_BALANCE_SOL (legacy).
const SOL_RESERVE = parseFloat(process.env.SOL_RESERVE ?? process.env.MIN_WALLET_BALANCE_SOL ?? '0.25')

const cfg = PRE_GRAD_STRATEGY

console.log(`[spot-buyer] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-buyer] buy=${cfg.position.spotBuySol} SOL | maxPos=${cfg.position.maxConcurrentSpots} | maxTotal=${cfg.position.maxTotalSpotSol} SOL`)
console.log(`[spot-buyer] SOL_RESERVE=${SOL_RESERVE} SOL (LP rent + fee buffer)`)

interface WatchlistRow {
  id: string
  mint: string
  symbol: string
  name: string
  volume_1h_usd: number
  status: string
  detected_at: string
}

interface SpotPositionInsert {
  mint:              string
  symbol:            string
  name:              string
  entry_price_sol:   number
  entry_price_usd:   number
  amount_sol:        number
  token_amount:      number
  tp_pct:            number
  sl_pct:            number
  status:            string
  dry_run:           boolean
  tx_buy?:           string
  watchlist_id?:     string
}

async function fetchPriceUsd(mint: string): Promise<number> {
  try {
    const res = await axios.get('https://api.jup.ag/price/v2', {
      params: { ids: mint },
      timeout: 6_000,
    })
    return parseFloat(res.data?.data?.[mint]?.price ?? '0')
  } catch {
    return 0
  }
}

async function getWalletSolBalance(publicKey: string): Promise<number> {
  try {
    const connection = new Connection(RPC_URL, 'confirmed')
    const lamports   = await connection.getBalance(new PublicKey(publicKey))
    return lamports / 1e9
  } catch {
    return 0
  }
}

async function getJupiterQuote(inputMint: string, outputMint: string, amountLamports: number) {
  const res = await axios.get(`${JUPITER_API}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount:              amountLamports,
      slippageBps:         SLIPPAGE_BPS,
      onlyDirectRoutes:    false,
      asLegacyTransaction: false,
    },
    timeout: 10_000,
  })
  return res.data
}

async function executeJupiterSwap(
  quote:  Record<string, unknown>,
  wallet: Keypair,
): Promise<string> {
  const connection = new Connection(RPC_URL, 'confirmed')

  const swapRes = await axios.post(`${JUPITER_API}/swap`, {
    quoteResponse:             quote,
    userPublicKey:             wallet.publicKey.toBase58(),
    wrapAndUnwrapSol:          true,
    dynamicComputeUnitLimit:   true,
    prioritizationFeeLamports: 'auto',
  }, { timeout: 15_000 })

  const { swapTransaction } = swapRes.data as { swapTransaction: string }
  const txBuf = Buffer.from(swapTransaction, 'base64')
  const tx    = VersionedTransaction.deserialize(txBuf)
  tx.sign([wallet])

  const sig = await connection.sendTransaction(tx, {
    skipPreflight:       false,
    maxRetries:          3,
    preflightCommitment: 'confirmed',
  })

  const latestBlockhash = await connection.getLatestBlockhash()
  await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, 'confirmed')

  return sig
}

/**
 * Checks position count and capital caps.
 * Also checks wallet balance vs SOL_RESERVE in live mode.
 */
async function canOpenNewPosition(
  walletPubkey?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('spot_positions')
    .select('amount_sol')
    .eq('status', 'open')

  if (error) return { ok: false, reason: `DB error: ${error.message}` }

  const rows      = data ?? []
  const openCount = rows.length
  const totalSol  = rows.reduce((sum, r) => sum + (r.amount_sol ?? 0), 0)

  if (openCount >= cfg.position.maxConcurrentSpots) {
    return { ok: false, reason: `max concurrent spots (${openCount}/${cfg.position.maxConcurrentSpots})` }
  }
  if (totalSol + cfg.position.spotBuySol > cfg.position.maxTotalSpotSol) {
    return { ok: false, reason: `max total SOL exceeded (${totalSol.toFixed(3)} + ${cfg.position.spotBuySol} > ${cfg.position.maxTotalSpotSol})` }
  }

  // Live-only: ensure wallet keeps SOL_RESERVE after this buy
  if (!DRY_RUN && walletPubkey) {
    const balance  = await getWalletSolBalance(walletPubkey)
    const required = cfg.position.spotBuySol + SOL_RESERVE
    if (balance < required) {
      return {
        ok:     false,
        reason: `wallet balance too low (${balance.toFixed(4)} SOL < ${cfg.position.spotBuySol} buy + ${SOL_RESERVE} reserve = ${required.toFixed(4)})`,
      }
    }
  }

  return { ok: true }
}

async function buyToken(row: WatchlistRow, walletPubkey?: string): Promise<void> {
  const supabase    = createServerClient()
  const buySol      = cfg.position.spotBuySol
  const buyLamports = Math.floor(buySol * 1e9)

  console.log(
    `[spot-buyer] evaluating ${row.symbol} (${row.mint.slice(0, 8)}...)` +
    ` vol=${row.volume_1h_usd.toFixed(2)} SOL`
  )

  // Volume filter — skip in dry-run so we can validate the full pipeline
  if (!DRY_RUN && row.volume_1h_usd < cfg.scanner.minVolume5minSol) {
    console.log(`[spot-buyer] SKIP ${row.symbol} — volume too low (${row.volume_1h_usd.toFixed(2)} < ${cfg.scanner.minVolume5minSol})`)
    return
  }
  if (DRY_RUN && row.volume_1h_usd < cfg.scanner.minVolume5minSol) {
    console.log(`[spot-buyer] DRY-RUN: vol=${row.volume_1h_usd.toFixed(2)} below threshold but proceeding for pipeline validation`)
  }

  // Dedup guard
  const { data: existing } = await supabase
    .from('spot_positions')
    .select('id')
    .eq('mint', row.mint)
    .in('status', ['open'])
    .maybeSingle()

  if (existing) {
    console.log(`[spot-buyer] SKIP ${row.symbol} — already have open position`)
    return
  }

  // Concurrency / capital / reserve guard
  const guard = await canOpenNewPosition(walletPubkey)
  if (!guard.ok) {
    console.log(`[spot-buyer] BLOCKED — ${guard.reason}`)
    if (guard.reason?.includes('wallet balance')) {
      await sendTelegram(`⚠️ LOW BALANCE — skipped ${row.symbol}\n${guard.reason}`)
    }
    return
  }

  // ---- DRY RUN ----
  if (DRY_RUN) {
    const entryPriceUsd = await fetchPriceUsd(row.mint)

    console.log(
      `[spot-buyer] DRY-RUN BUY ${buySol} SOL → ${row.symbol}` +
      ` | TP=+${cfg.exits.takeProfitPct}% SL=${cfg.exits.stopLossPct}% maxHold=${cfg.exits.maxHoldMinutes}min`
    )

    const position: SpotPositionInsert = {
      mint:            row.mint,
      symbol:          row.symbol,
      name:            row.name ?? '',
      entry_price_sol: 0,
      entry_price_usd: entryPriceUsd,
      amount_sol:      buySol,
      token_amount:    0,
      tp_pct:          cfg.exits.takeProfitPct,
      sl_pct:          cfg.exits.stopLossPct,
      status:          'open',
      dry_run:         true,
      watchlist_id:    row.id,
    }

    const { error: insertErr } = await supabase.from('spot_positions').insert(position)
    if (insertErr) {
      console.error(`[spot-buyer] DB insert error:`, insertErr.message)
      return
    }

    console.log(`[spot-buyer] DRY-RUN row inserted for ${row.symbol}`)

    await supabase
      .from('pre_grad_watchlist')
      .update({ status: 'opened' })
      .eq('id', row.id)

    await sendTelegram(
      `🟡 [DRY-RUN] BUY ${row.symbol}\n` +
      `💰 ${buySol} SOL | TP +${cfg.exits.takeProfitPct}% | SL ${cfg.exits.stopLossPct}%\n` +
      `📊 Vol: ${row.volume_1h_usd.toFixed(1)} SOL\n` +
      `🔗 https://pump.fun/${row.mint}`
    )

    return
  }

  // ---- LIVE BUY ----
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY
  if (!privateKeyEnv) {
    console.error('[spot-buyer] WALLET_PRIVATE_KEY not set — cannot execute live buy')
    return
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyEnv))

  let txSig:         string | undefined
  let tokensReceived = 0
  let entryPriceSol  = 0
  let entryPriceUsd  = 0

  try {
    console.log(`[spot-buyer] LIVE BUY ${buySol} SOL → ${row.symbol} (${row.mint.slice(0, 8)}...)`)

    const [quote, priceUsd] = await Promise.all([
      getJupiterQuote(WSOL_MINT, row.mint, buyLamports),
      fetchPriceUsd(row.mint),
    ])

    const outAmount = parseInt(quote.outAmount as string)
    tokensReceived  = outAmount / 1e6
    entryPriceSol   = buySol / tokensReceived
    entryPriceUsd   = priceUsd

    console.log(
      `[spot-buyer] quote: ${buySol} SOL → ${tokensReceived.toFixed(2)} ${row.symbol}` +
      ` @ ${entryPriceSol.toExponential(4)} SOL | $${entryPriceUsd.toExponential(4)}`
    )

    txSig = await executeJupiterSwap(quote as Record<string, unknown>, wallet)
    console.log(`[spot-buyer] BUY confirmed | tx=${txSig}`)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[spot-buyer] buy tx failed for ${row.symbol}:`, message)
    await sendTelegram(`❌ BUY FAILED ${row.symbol}\n${message}`)
    return
  }

  const position: SpotPositionInsert = {
    mint:            row.mint,
    symbol:          row.symbol,
    name:            row.name ?? '',
    entry_price_sol: entryPriceSol,
    entry_price_usd: entryPriceUsd,
    amount_sol:      buySol,
    token_amount:    tokensReceived,
    tp_pct:          cfg.exits.takeProfitPct,
    sl_pct:          cfg.exits.stopLossPct,
    status:          'open',
    dry_run:         false,
    tx_buy:          txSig,
    watchlist_id:    row.id,
  }

  const { error: insertErr } = await supabase.from('spot_positions').insert(position)
  if (insertErr) {
    console.error(`[spot-buyer] DB insert error:`, insertErr.message)
  } else {
    console.log(`[spot-buyer] position saved for ${row.symbol}`)
  }

  await supabase
    .from('pre_grad_watchlist')
    .update({ status: 'opened' })
    .eq('id', row.id)

  await sendTelegram(
    `🟢 BUY ${row.symbol}\n` +
    `💰 ${buySol} SOL | TP +${cfg.exits.takeProfitPct}% | SL ${cfg.exits.stopLossPct}%\n` +
    `📊 Vol: ${row.volume_1h_usd.toFixed(1)} SOL | Entry: $${entryPriceUsd.toExponential(3)}\n` +
    `🔗 https://solscan.io/tx/${txSig}`
  )
}

async function tick(): Promise<void> {
  const supabase = createServerClient()

  // Resolve wallet pubkey once per tick for live balance check
  let walletPubkey: string | undefined
  if (!DRY_RUN) {
    try {
      const pk = process.env.WALLET_PRIVATE_KEY
      if (pk) walletPubkey = Keypair.fromSecretKey(bs58.decode(pk)).publicKey.toBase58()
    } catch {}
  }

  const { data: watchlist, error } = await supabase
    .from('pre_grad_watchlist')
    .select('*')
    .eq('status', 'watching')
    .order('detected_at', { ascending: true })
    .limit(20)

  if (error) {
    console.error('[spot-buyer] watchlist fetch error:', error.message)
    return
  }

  const rows = (watchlist ?? []) as WatchlistRow[]
  console.log(`[spot-buyer] tick — ${rows.length} tokens on watchlist`)

  for (const row of rows) {
    await buyToken(row, walletPubkey)
  }
}

async function main(): Promise<void> {
  await tick()
  setInterval(tick, POLL_INTERVAL)
}

main().catch(err => {
  console.error('[spot-buyer] fatal:', err)
  process.exit(1)
})
