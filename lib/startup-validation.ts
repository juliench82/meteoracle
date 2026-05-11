/**
 * Startup validation — run once per process before any on-chain activity.
 * Checks:
 *   1. WALLET_PRIVATE_KEY is present and valid base58 (64-byte keypair)
 *   2. Derived wallet has >= MIN_SOL_BALANCE SOL
 *
 * Throws on failure so PM2 restarts the process instead of silently degrading.
 */
import { Keypair, PublicKey } from '@solana/web3.js'
import { getConnection } from '@/lib/solana'

const MIN_SOL_BALANCE = parseFloat(process.env.WALLET_MIN_SOL_RESERVE ?? '0.1') + 0.07 // reserve + meteora rent
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function isValidBase58(s: string): boolean {
  return s.split('').every(c => BASE58_CHARS.includes(c))
}

function decodeBase58(s: string): Uint8Array {
  const alphabet = BASE58_CHARS
  let n = BigInt(0)
  for (const c of s) {
    n = n * BigInt(58) + BigInt(alphabet.indexOf(c))
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  let leadingZeros = 0
  for (const c of s) {
    if (c === '1') leadingZeros++
    else break
  }
  return new Uint8Array([...Array(leadingZeros).fill(0), ...bytes])
}

export async function validateStartup(label: string): Promise<void> {
  const raw = process.env.WALLET_PRIVATE_KEY

  if (!raw || raw.trim() === '') {
    throw new Error(`${label} FATAL: WALLET_PRIVATE_KEY is not set`)
  }

  const key = raw.trim()

  if (!isValidBase58(key)) {
    throw new Error(`${label} FATAL: WALLET_PRIVATE_KEY contains invalid base58 characters`)
  }

  let keypair: Keypair
  try {
    const bytes = decodeBase58(key)
    if (bytes.length !== 64) {
      throw new Error(`expected 64 bytes, got ${bytes.length}`)
    }
    keypair = Keypair.fromSecretKey(bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} FATAL: WALLET_PRIVATE_KEY is not a valid Solana keypair — ${msg}`)
  }

  const connection = getConnection()
  let balanceLamports: number
  try {
    balanceLamports = await connection.getBalance(keypair.publicKey)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} FATAL: could not fetch wallet balance — RPC error: ${msg}`)
  }

  const balanceSol = balanceLamports / 1e9
  const pubkey = keypair.publicKey.toBase58()

  console.log(`${label} wallet: ${pubkey.slice(0, 8)}…${pubkey.slice(-4)} | balance: ${balanceSol.toFixed(4)} SOL`)

  if (balanceSol < MIN_SOL_BALANCE) {
    throw new Error(
      `${label} FATAL: wallet balance too low — ` +
      `${balanceSol.toFixed(4)} SOL < required ${MIN_SOL_BALANCE.toFixed(4)} SOL ` +
      `(WALLET_MIN_SOL_RESERVE=${process.env.WALLET_MIN_SOL_RESERVE ?? '0.1'} + meteora_rent=0.07)`,
    )
  }

  console.log(`${label} startup validation passed ✔`)
}
