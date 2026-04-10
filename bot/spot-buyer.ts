/**
 * spot-buyer.ts
 *
 * Reads the pre_grad_watchlist from Supabase, buys qualifying tokens via
 * Jupiter v6 REST API, and stores the position in spot_positions.
 *
 * Dry-run mode (default): logs everything, submits NO transactions.
 *   BOT_DRY_RUN=true   → dry-run (DEFAULT if env var absent)
 *   BOT_DRY_RUN=false  → live mode — REAL money
 *
 * REQUIRED ENV VARS:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUIRED ENV VARS (live mode only):
 *   WALLET_PRIVATE_KEY   — base58-encoded private key
 *   HELIUS_RPC_URL       — Helius or other Solana RPC endpoint
 *
 * OPTIONAL ENV VARS (all have defaults from strategy config):
 *   SPOT_BUY_SOL          — SOL per position (default: 0.05)
 *   MAX_CONCURRENT_SPOTS  — max open positions (default: 3)
 *   MAX_TOTAL_SPOT_SOL    — max total SOL deployed (default: 0.15)
 *   SPOT_BUY_SLIPPAGE_BPS — slippage tolerance in bps (default: 300)
 *
 * Run:
 *   npx tsx bot/spot-buyer.ts
 */

import axios from 'axios'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'

// ── Config ───────────────────────────────────────────────────────────────────
const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const RPC_URL       = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const JUPITER_API   = 'https://quote-api.jup.ag/v6'
const WSOL_MINT     = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS  = parseInt(process.env.SPOT_BUY_SLIPPAGE_BPS ?? '300')  // 3%
const POLL_INTERVAL = parseInt(process.env.SPOT_BUYER_POLL_SEC   ?? '30') * 1_000

const cfg = PRE_GRAD_STRATEGY

console.log(`[spot-buyer] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-buyer] buy=${cfg.position.spotBuySol} SOL | maxPos=${cfg.position.maxConcurrentSpots} | maxTotal=${cfg.position.maxTotalSpotSol} SOL`)

// ── Types ────────────────────────────────────────────────────────────────────
interface WatchlistRow {
  id: string
  mint: string
  symbol: string
  name: string
  volume_1h_usd: number
  status: string
  detected_at: string
}

interface SpotPosition {
  token_symbol:    string
  token_address:   string
  strategy_id:     string
  entry_price_sol: number
  sol_spent:       number
  tokens_bought:   number
  status:          string
  metadata:        Record<string, unknown>
}

// ── Jupiter helpers ──────────────────────────────────────────────────────────
async function getTokenDecimals(mint: string): Promise<number> {
  try {
    const connection = new Connection(RPC_URL, 'confirmed')
    const info = await connection.getParsedAccountInfo(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { toBase58: () => mint } as any
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (info.value?.data as any)?.parsed?.info?.decimals ?? 6
  } catch {
    return 6  // pump.fun tokens are all 6 decimals
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
    skipPreflight:        false,
    maxRetries:           3,
    preflightCommitment: 'confirmed',
  })

  const latestBlockhash = await connection.getLatestBlockhash()
  await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed'
  )

  return sig
}

// ── Guard: check open position count and total SOL deployed ──────────────────
async function canOpenNewPosition(): Promise<{ ok: boolean; reason?: string }> {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('spot_positions')
    .select('sol_spent')
    .eq('status', 'active')

  if (error) return { ok: false, reason: `DB error: ${error.message}` }

  const rows        = data ?? []
  const openCount   = rows.length
  const totalSol    = rows.reduce((sum, r) => sum + (r.sol_spent ?? 0), 0)

  if (openCount >= cfg.position.maxConcurrentSpots) {
    return { ok: false, reason: `max concurrent spots reached (${openCount}/${cfg.position.maxConcurrentSpots})` }
  }
  if (totalSol + cfg.position.spotBuySol > cfg.position.maxTotalSpotSol) {
    return { ok: false, reason: `max total SOL would be exceeded (${totalSol.toFixed(3)} + ${cfg.position.spotBuySol} > ${cfg.position.maxTotalSpotSol})` }
  }

  return { ok: true }
}

// ── Core buy logic ────────────────────────────────────────────────────────────
async function buyToken(row: WatchlistRow): Promise<void> {
  const supabase       = createServerClient()
  const buySol         = cfg.position.spotBuySol
  const buyLamports    = Math.floor(buySol * 1e9)

  console.log(
    `[spot-buyer] evaluating ${row.symbol} (${row.mint.slice(0, 8)}...)` +
    ` vol=${row.volume_1h_usd.toFixed(2)} SOL`
  )

  // ── Apply additional volume filter ──────────────────────────────────────
  if (row.volume_1h_usd < cfg.scanner.minVolume5minSol) {
    console.log(`[spot-buyer] SKIP ${row.symbol} — volume too low (${row.volume_1h_usd.toFixed(2)} < ${cfg.scanner.minVolume5minSol})`)
    return
  }

  // ── Already have a position? ─────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('spot_positions')
    .select('id')
    .eq('token_address', row.mint)
    .in('status', ['active', 'migrated'])
    .maybeSingle()

  if (existing) {
    console.log(`[spot-buyer] SKIP ${row.symbol} — already have active/migrated position`)
    return
  }

  // ── Guard ────────────────────────────────────────────────────────────────
  const guard = await canOpenNewPosition()
  if (!guard.ok) {
    console.log(`[spot-buyer] BLOCKED — ${guard.reason}`)
    return
  }

  // ── DRY-RUN path ─────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(
      `[spot-buyer] DRY-RUN BUY ${buySol} SOL → ${row.symbol}` +
      ` | TP=+${cfg.exits.takeProfitPct}% SL=${cfg.exits.stopLossPct}% maxHold=${cfg.exits.maxHoldMinutes}min`
    )

    // Still write a dry-run row to DB so the full pipeline can be tested end-to-end
    const position: SpotPosition = {
      token_symbol:    row.symbol,
      token_address:   row.mint,
      strategy_id:     cfg.id,
      entry_price_sol: 0,          // unknown in dry-run
      sol_spent:       buySol,
      tokens_bought:   0,          // unknown in dry-run
      status:          'active',
      metadata: {
        dry_run:     true,
        watchlist_id: row.id,
        slippage_bps: SLIPPAGE_BPS,
        take_profit_pct: cfg.exits.takeProfitPct,
        stop_loss_pct:   cfg.exits.stopLossPct,
        max_hold_min:    cfg.exits.maxHoldMinutes,
        volume_at_buy:   row.volume_1h_usd,
      },
    }

    const { error: insertErr } = await supabase
      .from('spot_positions')
      .insert(position)

    if (insertErr) {
      console.error(`[spot-buyer] DB insert error:`, insertErr.message)
    } else {
      console.log(`[spot-buyer] DRY-RUN row inserted for ${row.symbol}`)
    }

    // Mark watchlist token as 'opened' so we don't double-buy
    await supabase
      .from('pre_grad_watchlist')
      .update({ status: 'opened' })
      .eq('id', row.id)

    return
  }

  // ── LIVE path ────────────────────────────────────────────────────────────
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY
  if (!privateKeyEnv) {
    console.error('[spot-buyer] WALLET_PRIVATE_KEY not set — cannot execute live buy')
    return
  }

  let txSig: string | undefined
  let tokensReceived = 0
  let entryPriceSol  = 0

  try {
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyEnv))

    console.log(`[spot-buyer] LIVE BUY ${buySol} SOL → ${row.symbol} (${row.mint.slice(0, 8)}...)`)

    // Get quote: SOL → token
    const quote = await getJupiterQuote(WSOL_MINT, row.mint, buyLamports)
    const outAmount = parseInt(quote.outAmount as string)
    const decimals  = await getTokenDecimals(row.mint)
    tokensReceived  = outAmount / Math.pow(10, decimals)
    entryPriceSol   = buySol / tokensReceived

    console.log(
      `[spot-buyer] quote: ${buySol} SOL → ${tokensReceived.toFixed(2)} ${row.symbol}` +
      ` @ ${entryPriceSol.toExponential(4)} SOL/token`
    )

    // Execute
    txSig = await executeJupiterSwap(quote as Record<string, unknown>, wallet)
    console.log(`[spot-buyer] BUY confirmed | tx=${txSig}`)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[spot-buyer] buy tx failed for ${row.symbol}:`, message)
    return
  }

  // ── Persist position ─────────────────────────────────────────────────────
  const position: SpotPosition = {
    token_symbol:    row.symbol,
    token_address:   row.mint,
    strategy_id:     cfg.id,
    entry_price_sol: entryPriceSol,
    sol_spent:       buySol,
    tokens_bought:   tokensReceived,
    status:          'active',
    metadata: {
      dry_run:         false,
      tx_signature:    txSig,
      watchlist_id:    row.id,
      slippage_bps:    SLIPPAGE_BPS,
      take_profit_pct: cfg.exits.takeProfitPct,
      stop_loss_pct:   cfg.exits.stopLossPct,
      max_hold_min:    cfg.exits.maxHoldMinutes,
      volume_at_buy:   row.volume_1h_usd,
    },
  }

  const { error: insertErr } = await supabase
    .from('spot_positions')
    .insert(position)

  if (insertErr) {
    console.error(`[spot-buyer] DB insert error:`, insertErr.message)
  } else {
    console.log(`[spot-buyer] position saved for ${row.symbol}`)
  }

  // Mark watchlist token as 'opened'
  await supabase
    .from('pre_grad_watchlist')
    .update({ status: 'opened' })
    .eq('id', row.id)
}

// ── Main poll loop ────────────────────────────────────────────────────────────
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
