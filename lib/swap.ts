import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

const NATIVE_MINT = 'So11111111111111111111111111111111111111112'
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6'
const SWAP_TIMEOUT_MS = 15_000
const SWAP_MAX_RETRIES = 2

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
      const delay = attempt * 2_000
      console.warn(`[swap] fetch failed (attempt ${attempt}/${SWAP_MAX_RETRIES}), retrying in ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
      return fetchWithRetry(url, options, attempt + 1)
    }
    throw err
  }
}

/**
 * Swaps all balance of `tokenMint` to native SOL via Jupiter.
 * Returns the swap signature, or null if nothing to swap or dry-run.
 */
export async function swapTokenToSol(
  tokenMint: string,
  label: string
): Promise<string | null> {
  if (process.env.BOT_DRY_RUN !== 'false') {
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

  console.log(`${label} [swap] swapping ${balance.toString()} lamports of ${tokenMint.slice(0, 8)}... → SOL`)

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
