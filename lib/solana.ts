import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { sendAlert } from '@/bot/alerter'

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let _connection: Connection | null = null

function cleanEnv(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (/^(YOUR_KEY|REDACTED|xxxx)/i.test(trimmed)) return null
  return trimmed
}

function heliusRpcFromApiKey(): string | null {
  const apiKey = cleanEnv(process.env.HELIUS_API_KEY)
  if (!apiKey) return null
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
}

export function getHeliusRpcEndpoint(): string | null {
  return heliusRpcFromApiKey() ?? cleanEnv(process.env.HELIUS_RPC_URL)
}

function splitRpcList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => cleanEnv(item))
    .filter((item): item is string => Boolean(item))
}

export function getRpcEndpointCandidates(options: { includePublicFallback?: boolean } = {}): string[] {
  const endpoints = [
    cleanEnv(process.env.RPC_URL),
    getHeliusRpcEndpoint(),
    ...splitRpcList(process.env.SOLANA_RPC_FALLBACK_URLS),
    ...(options.includePublicFallback && process.env.DISABLE_PUBLIC_RPC_FALLBACK !== 'true'
      ? ['https://api.mainnet-beta.solana.com']
      : []),
  ].filter((endpoint): endpoint is string => Boolean(endpoint))

  return Array.from(new Set(endpoints))
}

/**
 * Warn loudly at startup if the public Solana RPC fallback is active.
 * In production DISABLE_PUBLIC_RPC_FALLBACK=true should be set.
 * This fires once per process so it doesn't spam logs.
 */
let _publicFallbackWarned = false
export function warnIfPublicFallbackActive(): void {
  if (_publicFallbackWarned) return
  _publicFallbackWarned = true
  if (process.env.DISABLE_PUBLIC_RPC_FALLBACK === 'true') return
  const hasDedicated =
    Boolean(cleanEnv(process.env.RPC_URL)) ||
    Boolean(getHeliusRpcEndpoint()) ||
    splitRpcList(process.env.SOLANA_RPC_FALLBACK_URLS).length > 0
  if (!hasDedicated) {
    const msg =
      '[solana] CRITICAL: no dedicated RPC endpoint configured — falling back to ' +
      'api.mainnet-beta.solana.com. Set RPC_URL or HELIUS_API_KEY and add ' +
      'DISABLE_PUBLIC_RPC_FALLBACK=true to prevent rate-limited stalls in production.'
    console.error(msg)
    sendAlert({ type: 'error', message: msg }).catch(() => {})
  }
}

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed')
}

export function getConnection(): Connection {
  if (!_connection) {
    warnIfPublicFallbackActive()
    const url = getRpcEndpointCandidates()[0]
    if (!url) throw new Error('RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
    _connection = createConnection(url)
  }
  return _connection
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

let _wallet: Keypair | null = null

export function getWallet(): Keypair {
  if (!_wallet) {
    const raw = process.env.WALLET_PRIVATE_KEY
    if (!raw) throw new Error('WALLET_PRIVATE_KEY is not set')
    try {
      if (raw.startsWith('[')) {
        _wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
      } else {
        _wallet = Keypair.fromSecretKey(bs58.decode(raw))
      }
    } catch {
      throw new Error('WALLET_PRIVATE_KEY is invalid — must be base58 or JSON uint8 array')
    }
  }
  return _wallet
}

export function getWalletPublicKey(): PublicKey {
  const raw = cleanEnv(process.env.WALLET_PUBLIC_KEY)
  if (!raw) return getWallet().publicKey

  try {
    return new PublicKey(raw)
  } catch {
    throw new Error('WALLET_PUBLIC_KEY is invalid')
  }
}

// ---------------------------------------------------------------------------
// Priority fee helper (uses Helius getPriorityFeeEstimate)
// ---------------------------------------------------------------------------

export async function getPriorityFee(accountKeys: string[]): Promise<number> {
  try {
    const connection = getConnection()
    const res = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getPriorityFeeEstimate',
        params: [{ accountKeys, options: { priorityLevel: 'High' } }],
      }),
    })
    const data = await res.json()
    return data?.result?.priorityFeeEstimate ?? 50_000
  } catch {
    return 50_000
  }
}

// ---------------------------------------------------------------------------
// Transaction builder helper
// ---------------------------------------------------------------------------

export async function buildAndSendTx(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  priorityFee: number
): Promise<string> {
  const connection = getConnection()
  const wallet = getWallet()

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed')

  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  ]

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...computeIxs, ...instructions],
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  tx.sign([wallet, ...signers])

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  })

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  )

  return sig
}

export { PublicKey }
