import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'

const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6'
const SWAP_TIMEOUT_MS = 20_000
const SWAP_MAX_RETRIES = 3
const SWAP_RETRY_DELAY_MS = 3_000

// Slippage ladder for swapTokenToSol: tries each tier in order until one lands.
// Env SWAP_SLIPPAGE_BPS overrides the starting tier (not the full ladder).
const SLIPPAGE_LADDER_BPS = [100, 300, 500, 1000, 2000, 5000]

function baseSlippageBps(): number {
  return parseInt(process.env.SWAP_SLIPPAGE_BPS ?? '100')
}

// Returns the ladder starting from the configured base slippage.
function slippageLadder(): number[] {
  const base = baseSlippageBps()
  const idx = SLIPPAGE_LADDER_BPS.findIndex(b => b >= base)
  return idx === -1 ? [base] : SLIPPAGE_LADDER_BPS.slice(idx)
}

async function getTokenBalance(connection: Connection, mint: string, owner: PublicKey): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
  if (!accounts.value.length) return 0n
  const amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount as string
  return BigInt(amount)
}

async function fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(SWAP_TIMEOUT_MS),
    })
    return res
  } catch (err) {
    if (attempt < SWAP_MAX_RETRIES) {
      const delay = attempt * SWAP_RETRY_DELAY_MS
      console.warn(`[swap] fetch failed (attempt ${attempt}/${SWAP_MAX_RETRIES}), retrying in ${delay}ms…`)
      await new Promise(r => setTimeout(r, delay))
      return fetchWithRetry(url, options, attempt + 1)
    }
    throw err
  }
}

/**
 * Sends a VersionedTransaction and confirms it, with a fallback to
 * getSignatureStatus on confirmTransaction timeout — mirrors executor.ts.
 */
async function sendAndConfirmVersioned(
  tx: VersionedTransaction,
  label: string,
): Promise<string> {
  const connection = getConnection()
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  } catch (confirmErr: unknown) {
    const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr)
    console.warn(`${label} confirmTransaction threw — checking chain directly for ${sig.slice(0, 8)}…`, errMsg)

    await new Promise(r => setTimeout(r, 3_000))
    const statusResp = await connection.getSignatureStatus(sig, { searchTransactionHistory: true })
    const status = statusResp.value

    if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      console.log(`${label} tx confirmed on-chain via status fallback ✔ (${status.confirmationStatus}) sig: ${sig}`)
      return sig
    }

    console.error(`${label} tx not confirmed on-chain after fallback check — sig: ${sig}`, { status })
    throw confirmErr
  }

  return sig
}

/**
 * Attempts a single Jupiter quote+swap at the given slippageBps.
 * Returns the tx signature on success, throws a typed error on failure.
 */
async function attemptSwap(
  tokenMint: string,
  balance: bigint,
  slippage: number,
  wallet: ReturnType<typeof getWallet>,
  label: string,
): Promise<string> {
  const quoteUrl =
    `${JUPITER_QUOTE_API}/quote?inputMint=${tokenMint}&outputMint=${NATIVE_MINT}` +
    `&amount=${balance.toString()}&slippageBps=${slippage}&onlyDirectRoutes=false`

  const quoteRes = await fetchWithRetry(quoteUrl, {})
  if (!quoteRes.ok) {
    const body = await quoteRes.text()
    throw new Error(`Jupiter quote failed (${slippage}bps): ${quoteRes.status} ${body}`)
  }
  const quote = await quoteRes.json()

  const swapRes = await fetchWithRetry(`${JUPITER_QUOTE_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!swapRes.ok) {
    const body = await swapRes.text()
    throw new Error(`Jupiter swap tx failed (${slippage}bps): ${swapRes.status} ${body}`)
  }
  const { swapTransaction } = await swapRes.json()

  const txBuf = Buffer.from(swapTransaction, 'base64')
  const tx = VersionedTransaction.deserialize(txBuf)
  tx.sign([wallet])

  const sig = await sendAndConfirmVersioned(tx, `${label}[swap]`)
  console.log(`${label} [swap] token → SOL confirmed ✔ sig: ${sig} | slippage: ${slippage}bps | outAmount: ${quote.outAmount}`)
  return sig
}

/**
 * Swaps all balance of `tokenMint` to native SOL via Jupiter.
 * Retries with escalating slippage (100 → 300 → 500 → 1000 → 2000 → 5000 bps)
 * before giving up. Returns the swap signature, or null if nothing to swap.
 * Throws on final failure — caller is responsible for alerting.
 */
export async function swapTokenToSol(
  tokenMint: string,
  label: string
): Promise<string | null> {
  if (process.env.BOT_DRY_RUN === 'true') {
    console.log(`${label} [swap] DRY RUN — skipping Jupiter swap`)
    return null
  }

  if (tokenMint === NATIVE_MINT) {
    console.log(`${label} [swap] token is native SOL — no swap needed`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  const balance = await getTokenBalance(connection, tokenMint, wallet.publicKey)
  if (balance === 0n) {
    console.log(`${label} [swap] zero token balance — nothing to swap`)
    return null
  }

  console.log(`${label} [swap] swapping ${balance.toString()} lamports of ${tokenMint.slice(0, 8)}… → SOL`)

  const ladder = slippageLadder()
  let lastError: unknown

  for (const slippage of ladder) {
    try {
      console.log(`${label} [swap] trying slippage ${slippage}bps…`)
      return await attemptSwap(tokenMint, balance, slippage, wallet, label)
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`${label} [swap] failed at ${slippage}bps: ${msg}`)
    }
  }

  throw lastError
}

/**
 * Retries stranded sell_failed positions across moonboy_positions and lp_positions.
 * Called at the top of every monitor tick. Swaps whatever token balance remains
 * in the wallet directly to SOL — no LP close attempted.
 * Promotes to status=closed on success, leaves as sell_failed if swap still fails.
 */
export async function retryStrandedSells(): Promise<{ retried: number; recovered: number }> {
  const stats = { retried: 0, recovered: 0 }

  if (process.env.BOT_DRY_RUN === 'true') {
    return stats
  }

  const supabase = createServerClient()

  // --- moonboy_positions ---
  const { data: moonboys } = await supabase
    .from('moonboy_positions')
    .select('id, mint, symbol, close_reason')
    .eq('status', 'sell_failed')
  
  for (const row of (moonboys ?? [])) {
    const label = `[retry-sell][moonboy][${row.symbol}]`
    stats.retried++
    try {
      const sig = await swapTokenToSol(row.mint, label)
      if (sig === null) {
        // Zero balance — token already gone, mark closed cleanly
        console.log(`${label} zero balance — marking closed without swap`)
      } else {
        console.log(`${label} recovered ✔ sig=${sig.slice(0, 8)}…`)
      }
      await supabase
        .from('moonboy_positions')
        .update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          tx_close: sig ?? 'zero_balance',
          close_reason: row.close_reason ?? 'sell_failed_recovered',
        })
        .eq('id', row.id)
      await sendAlert({
        type: 'moonboy_closed',
        symbol: row.symbol,
        mint: row.mint,
        pnlPct: 0,
        reason: `sell_failed_recovered`,
        ageHours: 0,
        swapSig: sig ?? 'zero_balance',
      }).catch(() => {})
      stats.recovered++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`${label} retry swap still failed — will try again next tick: ${msg}`)
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'stranded_sell_retry_failed',
        payload: { table: 'moonboy_positions', id: row.id, symbol: row.symbol, mint: row.mint, error: msg },
      }).then(() => {}, () => {})
    }
  }

  // --- lp_positions ---
  const { data: lpRows } = await supabase
    .from('lp_positions')
    .select('id, symbol, metadata, close_reason')
    .eq('status', 'sell_failed')

  for (const row of (lpRows ?? [])) {
    const mint: string | undefined = (row.metadata as Record<string, unknown> | null)?.token_mint as string | undefined
    const label = `[retry-sell][lp][${row.symbol}]`
    stats.retried++

    if (!mint) {
      console.warn(`${label} no token_mint in metadata — cannot retry swap, skipping`)
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'stranded_sell_no_mint',
        payload: { table: 'lp_positions', id: row.id, symbol: row.symbol },
      }).then(() => {}, () => {})
      continue
    }

    try {
      const sig = await swapTokenToSol(mint, label)
      if (sig === null) {
        console.log(`${label} zero balance — marking closed without swap`)
      } else {
        console.log(`${label} recovered ✔ sig=${sig.slice(0, 8)}…`)
      }
      await supabase
        .from('lp_positions')
        .update({
          status: 'closed',
          closed_at: new Date().toISOString(),
          tx_close: sig ?? 'zero_balance',
          close_reason: row.close_reason ?? 'sell_failed_recovered',
        })
        .eq('id', row.id)
      await sendAlert({
        type: 'position_closed',
        symbol: row.symbol,
        strategy: 'sell_failed_recovery',
        reason: 'sell_failed_recovered',
        ilPct: 0,
        ageHours: 0,
      }).catch(() => {})
      stats.recovered++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`${label} retry swap still failed — will try again next tick: ${msg}`)
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'stranded_sell_retry_failed',
        payload: { table: 'lp_positions', id: row.id, symbol: row.symbol, mint, error: msg },
      }).then(() => {}, () => {})
    }
  }

  return stats
}

/**
 * Buys `usdAmount` worth of `tokenMint` using SOL via Jupiter.
 * Returns { sig, solSpent, tokenAmountOut } or throws.
 */
export async function buyTokenWithSol(
  tokenMint: string,
  solPriceUsd: number,
  usdAmount: number,
  label: string,
): Promise<{ sig: string; solSpent: number; tokenAmountOut: bigint }> {
  if (process.env.BOT_DRY_RUN === 'true') {
    console.log(`${label} [swap] DRY RUN — skipping Jupiter buy`)
    return { sig: 'DRY_RUN', solSpent: 0, tokenAmountOut: 0n }
  }

  if (tokenMint === NATIVE_MINT) throw new Error('buyTokenWithSol: cannot buy native SOL')
  if (solPriceUsd <= 0) throw new Error('buyTokenWithSol: solPriceUsd must be > 0')

  const solAmount = usdAmount / solPriceUsd
  const lamports = BigInt(Math.floor(solAmount * 1e9))
  if (lamports === 0n) throw new Error('buyTokenWithSol: lamport amount rounds to zero')

  const connection = getConnection()
  const wallet = getWallet()

  console.log(`${label} [swap] buying ~$${usdAmount} (${solAmount.toFixed(5)} SOL) of ${tokenMint.slice(0, 8)}…`)

  const quoteUrl =
    `${JUPITER_QUOTE_API}/quote?inputMint=${NATIVE_MINT}&outputMint=${tokenMint}` +
    `&amount=${lamports.toString()}&slippageBps=${baseSlippageBps()}&onlyDirectRoutes=false`
  const quoteRes = await fetchWithRetry(quoteUrl, {})
  if (!quoteRes.ok) throw new Error(`Jupiter buy quote failed: ${quoteRes.status} ${await quoteRes.text()}`)
  const quote = await quoteRes.json()

  const swapRes = await fetchWithRetry(`${JUPITER_QUOTE_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!swapRes.ok) throw new Error(`Jupiter buy swap tx failed: ${swapRes.status} ${await swapRes.text()}`)
  const { swapTransaction } = await swapRes.json()

  const txBuf = Buffer.from(swapTransaction, 'base64')
  const tx = VersionedTransaction.deserialize(txBuf)
  tx.sign([wallet])

  const sig = await sendAndConfirmVersioned(tx, `${label}[buy]`)
  const tokenAmountOut = BigInt(quote.outAmount ?? '0')
  console.log(`${label} [swap] buy confirmed ✔ sig: ${sig} | outAmount: ${tokenAmountOut.toString()}`)
  return { sig, solSpent: Number(lamports) / 1e9, tokenAmountOut }
}
