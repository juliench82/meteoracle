import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import bs58 from 'bs58'

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let _connection: Connection | null = null

export function getConnection(): Connection {
  if (!_connection) {
    const url = process.env.HELIUS_RPC_URL
    if (!url) throw new Error('HELIUS_RPC_URL is not set')
    _connection = new Connection(url, 'confirmed')
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
      // Support both base58 string and JSON array formats
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
    return data?.result?.priorityFeeEstimate ?? 50_000 // default 50k microlamports
  } catch {
    return 50_000
  }
}

// ---------------------------------------------------------------------------
// Transaction builder helper
// ---------------------------------------------------------------------------

export async function buildAndSendTx(
  instructions: Parameters<typeof TransactionMessage>[0]['instructions'],
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
