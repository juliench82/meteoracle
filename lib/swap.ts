import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'

const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API_URL ?? 'https://public.jupiterapi.com'
const SWAP_TIMEOUT_MS = 20_000
const SWAP_MAX_RETRIES = 3
const SWAP_RETRY_DELAY_MS = 3_000

// Shared slippage ladder for both buy and sell paths.
// Pump.fun/DBC graduates are illiquid — sub-500bps virtually never fills.
// 2000bps (20%) is the hard ceiling.
const SWAP_SLIPPAGE_LADDER = [500, 1000, 2000]

/**
 * Pre-flight check: can we currently buy `outputMint` paying with SOL on Jupiter?
 * Returns true only if a quote succeeds with positive outAmount (no error).
 * Uses onlyDirectRoutes=false for maximum route discovery (preflight probe only).
 */
export async function hasJupiterRouteSolToToken(
  outputMint: string,
  amountLamports = '50000000', // ~0.05 SOL test amount
  slippageBps = 1000
): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      inputMint: NATIVE_MINT,
      outputMint,
      amount: amountLamports,
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
    });
    const url = `https://api.jup.ag/swap/v1/quote?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return false;
    const quote = await res.json();
    if (quote?.error || quote?.errorCode) return false;
    const out = quote?.outAmount ?? quote?.out_amount;
    return !!(out && BigInt(out) > 0n);
  } catch {
    return false;
  }
}

async function getTokenBalance(connection: Connection, mint: string, owner: PublicKey): Promise<bigint> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
  if (!accounts.value.length) return 0n
  const amount = accounts.value[0].account.data.parsed.info.tokenAmount.amount as string
  return BigInt(amount)
}

/** Public helper for stranded recovery (and any other wallet balance checks). */
export async function getWalletTokenBalance(mint: string): Promise<bigint> {
  const connection = getConnection()
  const wallet = getWallet()
  return getTokenBalance(connection, mint, wallet.publicKey)
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
 * Sends a VersionedTransaction and confirms it.
 * Fetches blockhash before send. Falls back to getSignatureStatus on confirm timeout.
 */
async function sendAndConfirmVersioned(
  tx: VersionedTransaction,
  label: string,
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })

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
 * Attempts a single Jupiter token→SOL swap at the given slippageBps.
 * Uses restrictIntermediateTokens=true to avoid multi-hop routes through
 * random meme coins that amplify price impact on micro-cap tokens.
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
    `&amount=${balance.toString()}&slippageBps=${slippage}&restrictIntermediateTokens=true`

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
 * Uses escalating slippage ladder: 500 → 1000 → 2000 bps.
 * Returns the swap signature, or null if nothing to swap.
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

  let lastError: unknown
  for (const slippage of SWAP_SLIPPAGE_LADDER) {
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
 * Attempts a single Jupiter SOL→token swap at the given slippageBps.
 * Uses restrictIntermediateTokens=true to avoid multi-hop routes through
 * random meme coins that amplify price impact on micro-cap tokens.
 */
async function attemptSwapSolToToken(
  tokenMint: string,
  solLamports: bigint,
  slippage: number,
  wallet: ReturnType<typeof getWallet>,
  label: string,
): Promise<{ sig: string; tokenAmount: bigint }> {
  const quoteUrl =
    `${JUPITER_QUOTE_API}/quote?inputMint=${NATIVE_MINT}&outputMint=${tokenMint}` +
    `&amount=${solLamports.toString()}&slippageBps=${slippage}&restrictIntermediateTokens=true`;

  const quoteRes = await fetchWithRetry(quoteUrl, {});
  if (!quoteRes.ok) {
    const body = await quoteRes.text();
    throw new Error(`Jupiter quote failed (${slippage}bps): ${quoteRes.status} ${body}`);
  }
  const quote = await quoteRes.json();

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
  });
  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap tx failed (${slippage}bps): ${swapRes.status} ${body}`);
  }
  const { swapTransaction } = await swapRes.json();

  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await sendAndConfirmVersioned(tx, `${label}[swap]`);
  const actualReceived = await getWalletTokenBalance(tokenMint);
  console.log(`${label} [swap] SOL → token confirmed ✔ sig: ${sig} | slippage: ${slippage}bps | actualReceived: ${actualReceived}`);
  return { sig, tokenAmount: actualReceived };
}

/**
 * Swaps a specific amount of native SOL to `tokenMint` via Jupiter (for one-sided open).
 * Uses escalating slippage ladder: 500 → 1000 → 2000 bps.
 * Returns the swap sig and actual on-chain token amount received.
 * Throws on final failure — caller responsible for alerting.
 */
export async function swapSolToToken(
  tokenMint: string,
  solLamports: bigint,
  label: string
): Promise<{ sig: string; tokenAmount: bigint } | null> {
  if (process.env.BOT_DRY_RUN === 'true') {
    console.log(`${label} [swap] DRY RUN — skipping Jupiter swap`)
    return null;
  }

  if (solLamports <= 0n) {
    console.log(`${label} [swap] zero SOL amount — nothing to swap`);
    return null;
  }

  console.log(`${label} [swap] swapping ${solLamports.toString()} lamports SOL → ${tokenMint.slice(0, 8)}`);

  let lastError: unknown;
  for (const slippage of SWAP_SLIPPAGE_LADDER) {
    try {
      console.log(`${label} [swap] trying slippage ${slippage}bps…`);
      return await attemptSwapSolToToken(tokenMint, solLamports, slippage, getWallet(), label);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${label} [swap] failed at ${slippage}bps: ${msg}`);
    }
  }

  throw lastError;
}

/**
 * Retries stranded sell_failed positions (and any recently closed positions that
 * still have a token balance in the wallet).
 *
 * Called at the top of every monitor tick (via monitor.ts).
 */
export async function retryStrandedSells(): Promise<{ retried: number; recovered: number }> {
  const positions = getOpenLpPositions()
  const now = Date.now()
  const recentMs = 7 * 24 * 3600 * 1000

  let retried = 0
  let recovered = 0

  for (const pos of positions) {
    const recoveryMint: string = (pos as any).stranded_token_mint || pos.mint || '';
    if (!recoveryMint) continue;

    const tsStr = (pos as any).closed_at || (pos as any).opened_at
    if (tsStr) {
      const ts = new Date(tsStr).getTime()
      if (now - ts > recentMs) continue
    }
    if (pos.status === 'active' || pos.status === 'open') continue

    const isSellFailed = pos.status === 'sell_failed'
    const isRecentClosed = pos.status === 'closed' && !(pos as any).stranded_recovered_at

    if (!isSellFailed && !isRecentClosed) continue

    try {
      const bal = await getWalletTokenBalance(recoveryMint)
      if (bal > 0n) {
        retried++
        const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
        const label = `[stranded-sell-retry][${sym}]`
        console.log(`${label} stranded balance=${bal} for ${recoveryMint} (status=${pos.status}) — recovering via Jupiter`)

        const sig = await swapTokenToSol(recoveryMint, label)
        if (sig) {
          recovered++
          console.log(`${label} recovered ✔ sig=${sig}`)
        }

        const all = getOpenLpPositions()
        const idx = all.findIndex((p: any) => p.id === pos.id)
        if (idx !== -1) {
          const nowIso = new Date().toISOString()
          if (sig) {
            all[idx].stranded_recovered_at = nowIso
            all[idx].stranded_recovered_sig = sig
            if (all[idx].status === 'sell_failed') {
              all[idx].status = 'closed'
            }
          } else {
            all[idx].last_stranded_check_at = nowIso
          }
          saveOpenLpPositions(all)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const sym = (pos as any).symbol || pos.mint.slice(0, 6)
      console.warn(`[swap] stranded retry failed for ${sym}: ${msg}`)
    }
  }

  if (retried > 0) {
    console.log(`[swap] stranded sells tick summary: retried=${retried} recovered=${recovered}`)
  }
  return { retried, recovered }
}
