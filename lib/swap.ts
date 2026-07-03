import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import BN from 'bn.js'
import * as fs from 'fs'
import * as path from 'path'
import { getConnection, getWallet } from '@/lib/solana'
import { sendAlert } from '@/bot/alerter'
import { getOpenLpPositions, saveOpenLpPositions, applyMonitorUpdates } from '@/lib/local-state'
import { atomicWriteJson } from './atomic-write'

export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
export const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API_URL ?? 'https://public.jupiterapi.com'
const SWAP_TIMEOUT_MS = 20_000
const SWAP_MAX_RETRIES = 3
const SWAP_RETRY_DELAY_MS = 3_000

// Note: main paths now use direct Meteora DLMM (see swapSolToTokenDirectOnDlmm in open.ts).
// The Jupiter-based helpers below are legacy (only for tests now).
const SWAP_SLIPPAGE_LADDER = [500, 1000, 2000];

const STATE_DIR = path.join(process.cwd(), 'state')
const STRANDED_BACKOFF_FILE = path.join(STATE_DIR, 'stranded-sell-backoff.json')
const STRANDED_SKIP_FILE = path.join(STATE_DIR, 'stranded-skip.json')

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
}

function loadStrandedBackoff(): Map<string, number> {
  try {
    ensureStateDir()
    if (fs.existsSync(STRANDED_BACKOFF_FILE)) {
      const data = JSON.parse(fs.readFileSync(STRANDED_BACKOFF_FILE, 'utf8'))
      if (data && typeof data === 'object') {
        return new Map(Object.entries(data).map(([k, v]) => [k, Number(v) || 0]))
      }
    }
  } catch {}
  return new Map()
}

function saveStrandedBackoff(map: Map<string, number>) {
  try {
    ensureStateDir()
    const obj: Record<string, number> = {}
    for (const [k, v] of map) obj[k] = v
    atomicWriteJson(STRANDED_BACKOFF_FILE, obj)
  } catch {}
}

function loadStrandedSkipList(): Set<string> {
  try {
    ensureStateDir()
    if (fs.existsSync(STRANDED_SKIP_FILE)) {
      const data = JSON.parse(fs.readFileSync(STRANDED_SKIP_FILE, 'utf8'))
      return new Set(Array.isArray(data) ? data : [])
    }
  } catch {}
  return new Set()
}

function saveStrandedSkipList(set: Set<string>) {
  try {
    ensureStateDir()
    atomicWriteJson(STRANDED_SKIP_FILE, Array.from(set))
  } catch {}
}

// Fresh-quote retry config for the pre-quoted path (Claude's fix).
// Each attempt fetches a *fresh* quote at an escalating slippage level before
// building the swap tx. This replaces the old "retry the same stale quoteResponse"
// approach which guaranteed 0x177e on every retry since the route was already stale.
// Slippage levels: 500 → 1000 → 2000 bps (matching the main ladder).
//
// (PREQUOTE_* kept for the legacy Jupiter helpers below; main bot no longer uses Jupiter ladders.)
const PREQUOTE_SLIPPAGE_LEVELS = [500, 1000, 2000];
const PREQUOTE_RETRY_BACKOFF_BASE_MS = 500;
export const PREQUOTE_MAX_ATTEMPTS = 3;

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
 * Sends a VersionedTransaction (typically from Jupiter) and confirms it.
 * Fetches blockhash before send for the confirm call (avoids using a post-send blockhash
 * which can cause premature timeouts even on landed txs). Falls back to getSignatureStatus.
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
 * Attempts a single Jupiter quote+swap at the given slippageBps (token→SOL).
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
    `&amount=${balance.toString()}&slippageBps=${slippage}&onlyDirectRoutes=false&restrictIntermediateTokens=true`

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
 * Retries with escalating slippage before giving up.
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

  const ladder = SWAP_SLIPPAGE_LADDER
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
 * Attempts a single SOL→token swap at the given slippage with a fresh quote.
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
    `&amount=${solLamports.toString()}&slippageBps=${slippage}&onlyDirectRoutes=false&restrictIntermediateTokens=true`;

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
 * Execute a SOL→token swap for the Bid-Ask pre-swap leg.
 *
 * Uses the initial pre-quoted quote (from open.ts) for the first attempt only.
 * If that fails with 0x177e (stale route / thin liquidity), fetches a FRESH quote
 * at escalating slippage levels (500 → 1000 → 2000 bps) rather than re-submitting
 * the same stale quoteResponse. This directly fixes the log pattern:
 *   "executeSwapFromPreQuote attempt 1/3 failed (0x177e)"
 *   "executeSwapFromPreQuote attempt 2/3 failed (0x177e)"  ← same stale quote, same error
 *   "executeSwapFromPreQuote attempt 3/3 failed (0x177e)"  ← same stale quote, same error
 *
 * Returns {sig, tokenAmount} on success, null if all levels exhausted (caller falls
 * back to swapSolToToken ladder which also no longer bails early on 0x177e).
 */
export async function executeSwapFromPreQuote(
  quote: any,
  wallet: ReturnType<typeof getWallet>,
  label: string
): Promise<{ sig: string; tokenAmount: bigint } | null> {
  if (!quote) return null;

  const outputMint: string = quote.outputMint || '';
  const solLamports = BigInt(quote.inAmount ?? quote.in_amount ?? '0');

  for (let i = 0; i < PREQUOTE_SLIPPAGE_LEVELS.length; i++) {
    const slippage = PREQUOTE_SLIPPAGE_LEVELS[i];
    // Attempt 1: use the pre-fetched quote directly (no extra round-trip).
    // Attempts 2+: fetch a fresh quote at the escalated slippage level.
    let swapQuote = i === 0 ? quote : null;

    try {
      if (!swapQuote) {
        console.log(`${label} [swap] pre-quote stale — fetching fresh quote at ${slippage}bps (attempt ${i + 1}/${PREQUOTE_SLIPPAGE_LEVELS.length})…`);
        const freshUrl = `${JUPITER_QUOTE_API}/quote?inputMint=${NATIVE_MINT}&outputMint=${outputMint}` +
          `&amount=${solLamports.toString()}&slippageBps=${slippage}&onlyDirectRoutes=false&restrictIntermediateTokens=true`;
        const freshRes = await fetch(freshUrl, { signal: AbortSignal.timeout(7000) });
        if (!freshRes.ok) throw new Error(`fresh quote http ${freshRes.status}`);
        swapQuote = await freshRes.json();
        if (swapQuote?.error || swapQuote?.errorCode) throw new Error(swapQuote.error || swapQuote.errorCode || 'quote error');
        const expectedOut = BigInt(swapQuote.outAmount ?? swapQuote.out_amount ?? '0');
        console.log(`${label} [swap] fresh quote OK at ${slippage}bps: ${solLamports} SOL → ~${expectedOut} token`);
      }

      const swapRes = await fetchWithRetry(`${JUPITER_QUOTE_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: swapQuote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
      if (!swapRes.ok) {
        const body = await swapRes.text();
        throw new Error(`Jupiter swap tx failed: ${swapRes.status} ${body}`);
      }
      const { swapTransaction } = await swapRes.json();

      const txBuf = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([wallet]);

      const sig = await sendAndConfirmVersioned(tx, `${label}[swap]`);
      const tokenAmount = await getWalletTokenBalance(outputMint);
      console.log(`${label} [swap] SOL → token confirmed ✔ (attempt ${i + 1}/${PREQUOTE_SLIPPAGE_LEVELS.length}, ${slippage}bps) sig: ${sig} | actualReceived: ${tokenAmount}`);
      return { sig, tokenAmount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRouteErr = msg.includes('0x177e') || msg.includes('custom program error') || msg.includes('route not executable');
      console.warn(`${label} [swap] attempt ${i + 1}/${PREQUOTE_SLIPPAGE_LEVELS.length} failed at ${slippage}bps${isRouteErr ? ' (0x177e)' : ''}: ${msg}`);

      if (i < PREQUOTE_SLIPPAGE_LEVELS.length - 1) {
        const delay = PREQUOTE_RETRY_BACKOFF_BASE_MS * (i + 1);
        console.log(`${label} [swap] escalating to ${PREQUOTE_SLIPPAGE_LEVELS[i + 1]}bps in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return null;
}

/**
 * Swaps a specific amount of native SOL to `tokenMint` via Jupiter (for one-sided open / Bid-Ask pre-fund).
 * Pre-validate quote exists before calling.
 * Uses unified higher slippage ladder + restrictIntermediateTokens=true.
 * Returns the swap sig and *actual* on-chain token amount received (post-slippage), or null on persistent failure.
 * Does NOT bail early on 0x177e — escalates slippage on each attempt through the full ladder.
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

  const ladder = SWAP_SLIPPAGE_LADDER;

  for (const slippage of ladder) {
    try {
      console.log(`${label} [swap] trying slippage ${slippage}bps…`);
      return await attemptSwapSolToToken(tokenMint, solLamports, slippage, getWallet(), label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log and continue to next slippage level — do NOT bail early on 0x177e.
      // Thin Token-2022 pools often succeed at higher slippage even when 500bps fails.
      console.warn(`${label} [swap] failed at ${slippage}bps: ${msg}`);
    }
  }

  console.warn(`${label} [swap] all ladder attempts exhausted for buy — skipping pool`);
  return null;
}

/**
 * Retries stranded sell_failed positions (and any recently closed positions that
 * still have a token balance in the wallet).
 *
 * Called at the top of every monitor tick (via monitor.ts).
 * Uses only local state + direct wallet balance query + direct Meteora DLMM swap.
 * Pure direct path — no Jupiter or other fallbacks.
 * On successful recovery: updates the position record (status -> closed if needed,
 * records recovered timestamp/sig). Failures are left for the next tick.
 */
export async function retryStrandedSells(): Promise<{ retried: number; recovered: number }> {
  let positions = getOpenLpPositions()
  const now = Date.now()
  const recentMs = 7 * 24 * 3600 * 1000
  const pruneMs = 90 * 24 * 3600 * 1000 // prune very old closed to keep state file small

  // Light prune of ancient closed records (prevents unbounded growth)
  const beforePrune = positions.length
  positions = positions.filter((p: any) => {
    if (p.status !== 'closed') return true
    const closedTs = p.closed_at ? new Date(p.closed_at).getTime() : 0
    return (now - closedTs) < pruneMs
  })
  if (positions.length !== beforePrune) {
    saveOpenLpPositions(positions)
  }

  // Persisted backoff (survives restart) for tokens failing liquidity.
  const backoff: Map<string, number> = loadStrandedBackoff()
  const skipList: Set<string> = loadStrandedSkipList()
  const LIQUIDITY_BACKOFF_MS = 5 * 60 * 1000 // 5 minutes after a liquidity failure
  const MAX_STRANDED_AGE_DAYS = 2
  const MAX_STRANDED_AGE_MIN = MAX_STRANDED_AGE_DAYS * 24 * 60

  if (!(globalThis as any).__strandedSellAlerted) {
    (globalThis as any).__strandedSellAlerted = new Set<string>()
  }
  const alerted: Set<string> = (globalThis as any).__strandedSellAlerted

  let retried = 0
  let recovered = 0
  let longStranded = 0

  for (const pos of positions) {
    const recoveryMint: string = (pos as any).stranded_token_mint || pos.mint || '';
    if (!recoveryMint) continue;

    if (skipList.has(recoveryMint)) continue // permanently abandoned

    const tsStr = (pos as any).closed_at || (pos as any).opened_at
    let ts: number | undefined
    if (tsStr) {
      ts = new Date(tsStr).getTime()
      if (now - ts > recentMs) continue
    }
    if (pos.status === 'active' || pos.status === 'open') continue

    const isSellFailed = pos.status === 'sell_failed'
    const isRecentClosed = pos.status === 'closed' && !(pos as any).stranded_recovered_at

    if (!isSellFailed && !isRecentClosed) continue

    const sellFailedAt = (pos as any).sell_failed_at ? new Date((pos as any).sell_failed_at).getTime() : (ts ? new Date(tsStr).getTime() : now)
    const strandedAgeMin = Math.max(0, (now - sellFailedAt) / 60000)

    if (strandedAgeMin > MAX_STRANDED_AGE_MIN) {
      // Hard cutoff: give up after 2 days, persist skip list
      skipList.add(recoveryMint)
      saveStrandedSkipList(skipList)
      const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
      console.warn(`[swap] ABANDONING stranded sell for ${sym} after ${MAX_STRANDED_AGE_DAYS}d — token likely illiquid.`)
      sendAlert({
        type: 'warning',
        message: `⚠️ Abandoning stranded sell for ${sym} after ${MAX_STRANDED_AGE_DAYS}d — token likely illiquid. Manual recovery needed.`,
      }).catch(() => {})
      continue
    }

    if (strandedAgeMin > 30 && !alerted.has(recoveryMint)) {
      longStranded++
      const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
      console.warn(`[swap] LONG STRANDED SELL: ${sym} mint=${recoveryMint} age=${Math.round(strandedAgeMin)}m — no max-retry cutoff; will keep trying with backoff.`)
      sendAlert({
        type: 'warning',
        message: `⚠️ Stranded sell for ${sym} still holding token after ~${Math.round(strandedAgeMin)}m (may be illiquid). Monitor will keep retrying.`,
      }).catch(() => {})
      alerted.add(recoveryMint)
    }

    // Backoff check
    const lastFail = backoff.get(recoveryMint) || 0
    if (now - lastFail < LIQUIDITY_BACKOFF_MS) {
      continue
    }

    try {
      const bal = await getWalletTokenBalance(recoveryMint)
      if (bal > 0n) {
        retried++
        const sym = (pos as any).symbol || recoveryMint.slice(0, 6)
        const label = `[stranded-sell-retry][${sym}]`
        console.log(`${label} stranded balance=${bal} for ${recoveryMint} (status=${pos.status}) — recovering via direct DLMM`)

        // Direct DLMM sell for stranded recovery (no fallbacks)
        let recoveredSig: string | undefined
        try {
          const mod = await import('@meteora-ag/dlmm')
          const DLMM = mod.default as any
          const poolAddr = (pos as any).pool_address || (pos as any).metadata?.pool_address
          if (poolAddr) {
            const connection = getConnection()
            const wallet = getWallet()
            const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddr))
            const isTokenX = dlmmPool.tokenX.publicKey.toBase58() === recoveryMint
            const inToken = isTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey
            const outToken = isTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey
            const binArrays = await dlmmPool.getBinArrays()
            console.log(`${label} [direct-dlmm-recovery] fetched ${binArrays.length} bin arrays for stranded sell quote (pool=${poolAddr}; passing FULL list to swap)`);
            const swapYtoX = (inToken.toBase58() === dlmmPool.tokenY.publicKey.toBase58())
            const currentBal = await getWalletTokenBalance(recoveryMint)
            if (currentBal > 0n) {
              const inputAmountBN = new BN(currentBal.toString())
              // For recovery, use moderately loose 20% for quote to get a sensible minOut, then use it (or div4 fallback).
              const swapQuote = await dlmmPool.swapQuote(inputAmountBN, swapYtoX, new BN(2000), binArrays)
              const q = swapQuote as any
              if (!q.outAmount.isZero()) {
                const quotedIn = q.inAmount ?? inputAmountBN;
                console.log(`${label} [direct-dlmm-recovery] quote: in=${quotedIn} out=${q.outAmount}`);
                const binArrayKeysForSwap = (q.binArraysPubkey && q.binArraysPubkey.length > 0)
                  ? q.binArraysPubkey
                  : binArrays.slice(0, 3).map((ba: any) => ba.publicKey);
                console.log(`${label} [direct-dlmm-recovery] calling swap with limited ${binArrayKeysForSwap.length} bin array pubkeys`);
                const swapTx = await dlmmPool.swap({
                  inToken,
                  binArraysPubkey: binArrayKeysForSwap,
                  inAmount: inputAmountBN,
                  lbPair: dlmmPool.pubkey,
                  user: wallet.publicKey,
                  // Use quote's minOut (already toleranced at 10000bps in quote) or very loose 25% of expected.
                  // Avoids total drain via zero protection while still allowing recovery on thin pools.
                  minOutAmount: (q.minOutAmount && !q.minOutAmount.isZero()) ? q.minOutAmount : q.outAmount.div(new BN(4)),
                  outToken,
                })
                const { sendLegacyTx, applyPriorityFee } = await import('@/lib/solana-tx')
                const prepared = applyPriorityFee(swapTx, 100000)
                recoveredSig = await sendLegacyTx(prepared, [wallet], label)
                console.log(`${label} direct DLMM stranded sell confirmed ✔ sig: ${recoveredSig}`)
                recovered++
                console.log(`${label} recovered ✔ sig=${recoveredSig}`)
                // update state via safe merge to avoid race with monitor's applyMonitorUpdates
                const nowIso = new Date().toISOString()
                applyMonitorUpdates([{
                  id: pos.id,
                  patch: {
                    stranded_recovered_at: nowIso,
                    stranded_recovered_sig: recoveredSig,
                    ...(pos.status === 'sell_failed' ? { status: 'closed' } : {})
                  }
                }])
                // clear backoff on success
                backoff.delete(recoveryMint)
                saveStrandedBackoff(backoff)
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`${label} direct DLMM stranded sell failed, will retry next monitor tick: ${msg}`)
          if (msg.includes('Insufficient liquidity') || msg.includes('SWAP_QUOTE_INSUFFICIENT')) {
            backoff.set(recoveryMint, now)
            saveStrandedBackoff(backoff)
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const sym = (pos as any).symbol || pos.mint.slice(0, 6)
      console.warn(`[swap] stranded retry failed for ${sym}: ${msg}`)
    }
  }

  if (retried > 0 || longStranded > 0) {
    console.log(`[swap] stranded sells tick summary: retried=${retried} recovered=${recovered} longStrandedWarned=${longStranded}`)
  }
  return { retried, recovered }
}
