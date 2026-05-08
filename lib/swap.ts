import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6'
const SWAP_TIMEOUT_MS = 20_000
const SWAP_MAX_RETRIES = 3
const SWAP_RETRY_DELAY_MS = 3_000

// Default: 1% slippage. Override via SWAP_SLIPPAGE_BPS env.
function slippageBps(): number {
  return parseInt(process.env.SWAP_SLIPPAGE_BPS ?? '100')
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
 * Swaps all balance of `tokenMint` to native SOL via Jupiter.
 * Returns the swap signature, or null if nothing to swap or dry-run.
 * Throws on final failure — caller is responsible for alerting.
 */
export async function swapTokenToSol(
  tokenMint: string,
  label: string
): Promise<string | null> {
  // Skip only when dry-run is explicitly enabled — mirrors executor.ts guard.
  if (process.env.BOT_DRY_RUN === 'true') {
    console.log(`${label} [swap] DRY RUN — skipping Jupiter swap`)
    return null
  }

  // SOL pool — nothing to swap
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

  // 1. Quote
  const quoteUrl = `${JUPITER_QUOTE_API}/quote?inputMint=${tokenMint}&outputMint=${NATIVE_MINT}&amount=${balance.toString()}&slippageBps=${slippageBps()}&onlyDirectRoutes=false`
  const quoteRes = await fetchWithRetry(quoteUrl, {})
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`)
  const quote = await quoteRes.json()

  // 2. Swap transaction
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
  if (!swapRes.ok) throw new Error(`Jupiter swap tx failed: ${swapRes.status} ${await swapRes.text()}`)
  const { swapTransaction } = await swapRes.json()

  // 3. Deserialize, sign, send
  const txBuf = Buffer.from(swapTransaction, 'base64')
  const tx = VersionedTransaction.deserialize(txBuf)
  tx.sign([wallet])

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')

  console.log(`${label} [swap] token → SOL confirmed ✔ sig: ${sig} | outAmount: ${quote.outAmount}`)
  return sig
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
    `&amount=${lamports.toString()}&slippageBps=${slippageBps()}&onlyDirectRoutes=false`
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

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')

  const tokenAmountOut = BigInt(quote.outAmount ?? '0')
  console.log(`${label} [swap] buy confirmed ✔ sig: ${sig} | outAmount: ${tokenAmountOut.toString()}`)
  return { sig, solSpent: Number(lamports) / 1e9, tokenAmountOut }
}
