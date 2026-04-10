/**
 * spot-seller.ts
 *
 * Sells a token position back to SOL via Jupiter v6 REST API.
 * Imported as a module — does NOT run a poll loop.
 *
 * BOT_DRY_RUN=true   → dry-run (default if env var absent)
 * BOT_DRY_RUN=false  → live
 */

// Load .env.local before anything else (safe to call multiple times)
import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

const DRY_RUN      = process.env.BOT_DRY_RUN !== 'false'
const RPC_URL      = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const JUPITER_API  = 'https://quote-api.jup.ag/v6'
const WSOL_MINT    = 'So11111111111111111111111111111111111111112'
const SLIPPAGE_BPS = parseInt(process.env.SELL_SLIPPAGE_BPS ?? '300')

export interface SellResult {
  success: boolean
  txSignature?: string
  solReceived?: number
  error?: string
  dryRun?: boolean
}

export async function sellTokenForSol(
  tokenMint: string,
  tokenAmount: number,
  tokenDecimals: number,
  label: string,
): Promise<SellResult> {
  const rawAmount = Math.floor(tokenAmount * Math.pow(10, tokenDecimals))

  if (DRY_RUN) {
    const approxSol = rawAmount / Math.pow(10, tokenDecimals)
    console.log(
      `[spot-seller] DRY-RUN sell ${approxSol.toFixed(4)} ${label}` +
      ` (${rawAmount} raw) → SOL | slippage=${SLIPPAGE_BPS}bps`
    )
    return { success: true, solReceived: 0, dryRun: true }
  }

  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY
  if (!privateKeyEnv) {
    return { success: false, error: 'WALLET_PRIVATE_KEY not set' }
  }

  try {
    const wallet     = Keypair.fromSecretKey(bs58.decode(privateKeyEnv))
    const connection = new Connection(RPC_URL, 'confirmed')

    const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint:           tokenMint,
        outputMint:          WSOL_MINT,
        amount:              rawAmount,
        slippageBps:         SLIPPAGE_BPS,
        onlyDirectRoutes:    false,
        asLegacyTransaction: false,
      },
      timeout: 10_000,
    })
    const quote = quoteRes.data
    const outLamports = parseInt(quote.outAmount as string)
    const solOut = outLamports / 1e9
    console.log(`[spot-seller] quote: sell ${label} → ~${solOut.toFixed(4)} SOL`)

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

    console.log(`[spot-seller] SOLD ${label} → ${solOut.toFixed(4)} SOL | tx=${sig}`)
    return { success: true, txSignature: sig, solReceived: solOut }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[spot-seller] sell failed for ${label}:`, message)
    return { success: false, error: message }
  }
}
