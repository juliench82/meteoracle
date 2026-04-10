/**
 * spot-buyer.ts
 *
 * Reads pre_grad_watchlist, buys qualifying tokens via Jupiter v6, and stores
 * positions in spot_positions.
 *
 * BOT_DRY_RUN=true  (default) — logs only, no real transactions
 * BOT_DRY_RUN=false           — live mode, REAL money
 *
 * Run:
 *   npx tsx bot/spot-buyer.ts
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const RPC_URL       = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const JUPITER_API   = 'https://quote-api.jup.ag/v6'
const WSOL_MINT     = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS  = parseInt(process.env.SPOT_BUY_SLIPPAGE_BPS ?? '300')
const POLL_INTERVAL = parseInt(process.env.SPOT_BUYER_POLL_SEC   ?? '30') * 1_000

const cfg = PRE_GRAD_STRATEGY

console.log(`[spot-buyer] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-buyer] buy=${cfg.position.spotBuySol} SOL | maxPos=${cfg.position.maxConcurrentSpots} | maxTotal=${cfg.position.maxTotalSpotSol} SOL`)

interface WatchlistRow {
  id: string
  mint: string
  symbol: string
  name: string
  volume_1h_usd: number
  status: string
  detected_at: string
}

// Matches public.spot_positions columns exactly
interface SpotPositionInsert {
  mint:             string
  symbol:           string
  name:             string
  entry_price_sol:  number
  amount_sol:       number
  token_amount:     number
  tp_pct:           number
  sl_pct:           number
  status:           string
  dry_run:          boolean
  tx_buy?:          string
  watchlist_id?:    string
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

async function canOpenNewPosition(): Promise<{ ok: boolean; reason?: string }> {
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

  return { ok: true }
}

async function buyToken(row: WatchlistRow): Promise<void> {
  const supabase    = createServerClient()
  const buySol      = cfg.position.spotBuySol
  const buyLamports = Math.floor(buySol * 1e9)

  console.log(
    `[spot-buyer] evaluating ${row.symbol} (${row.mint.slice(0, 8)}...)` +
    ` vol=${row.volume_1h_usd.toFixed(2)} SOL`
  )

  // Volume filter
  if (row.volume_1h_usd < cfg.scanner.minVolume5minSol) {
    console.log(`[spot-buyer] SKIP ${row.symbol} — volume too low (${row.volume_1h_usd.toFixed(2)} < ${cfg.scanner.minVolume5minSol})`)
    return
  }

  // Dedup guard: don't buy same token twice
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

  // Concurrency / capital guard
  const guard = await canOpenNewPosition()
  if (!guard.ok) {
    console.log(`[spot-buyer] BLOCKED — ${guard.reason}`)
    return
  }

  // ---- DRY RUN ----
  if (DRY_RUN) {
    console.log(
      `[spot-buyer] DRY-RUN BUY ${buySol} SOL → ${row.symbol}` +
      ` | TP=+${cfg.exits.takeProfitPct}% SL=${cfg.exits.stopLossPct}% maxHold=${cfg.exits.maxHoldMinutes}min`
    )

    const position: SpotPositionInsert = {
      mint:            row.mint,
      symbol:          row.symbol,
      name:            row.name ?? '',
      entry_price_sol: 0,
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

    return
  }

  // ---- LIVE BUY ----
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY
  if (!privateKeyEnv) {
    console.error('[spot-buyer] WALLET_PRIVATE_KEY not set — cannot execute live buy')
    return
  }

  let txSig:         string | undefined
  let tokensReceived = 0
  let entryPriceSol  = 0

  try {
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyEnv))
    console.log(`[spot-buyer] LIVE BUY ${buySol} SOL → ${row.symbol} (${row.mint.slice(0, 8)}...)`)

    const quote     = await getJupiterQuote(WSOL_MINT, row.mint, buyLamports)
    const outAmount = parseInt(quote.outAmount as string)
    // pump.fun tokens are always 6 decimals
    tokensReceived  = outAmount / 1e6
    entryPriceSol   = buySol / tokensReceived

    console.log(
      `[spot-buyer] quote: ${buySol} SOL → ${tokensReceived.toFixed(2)} ${row.symbol}` +
      ` @ ${entryPriceSol.toExponential(4)} SOL/token`
    )

    txSig = await executeJupiterSwap(quote as Record<string, unknown>, wallet)
    console.log(`[spot-buyer] BUY confirmed | tx=${txSig}`)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[spot-buyer] buy tx failed for ${row.symbol}:`, message)
    return
  }

  const position: SpotPositionInsert = {
    mint:            row.mint,
    symbol:          row.symbol,
    name:            row.name ?? '',
    entry_price_sol: entryPriceSol,
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
}

async function tick(): Promise<void> {
  const supabase = createServerClient()

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
    await buyToken(row)
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
