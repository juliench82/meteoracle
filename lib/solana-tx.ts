/**
 * lib/solana-tx.ts
 *
 * Shared Solana transaction utilities.
 *
 * Provides:
 * - Priority fee helpers
 * - Simulation with good error handling
 * - Robust legacy transaction sending with fallback confirmation
 */

import {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  Connection,
} from '@solana/web3.js'
import { getConnection } from './solana'
import { logError } from './log'

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58()
const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3

export function computeBudgetKind(ix: TransactionInstruction): number | null {
  if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) return null
  return ix.data[0] ?? null
}

export function addPriorityFeeAndPreserveComputeLimit(
  ixs: TransactionInstruction[],
  priorityFee: number,
  fallbackUnits: number,
): TransactionInstruction[] {
  const withoutUnitPrice = ixs.filter(ix => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_PRICE)
  const hasUnitLimit = withoutUnitPrice.some(ix => computeBudgetKind(ix) === COMPUTE_BUDGET_SET_UNIT_LIMIT)

  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    ...(hasUnitLimit ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: fallbackUnits })]),
    ...withoutUnitPrice,
  ]
}

export function applyPriorityFee(
  tx: Transaction,
  priorityFee: number,
  fallbackUnits: number = 1_400_000,
): Transaction {
  tx.instructions = addPriorityFeeAndPreserveComputeLimit(tx.instructions, priorityFee, fallbackUnits)
  return tx
}

/**
 * Simulates a transaction and returns whether it looks safe to send.
 * Logs useful information on failure.
 */
export async function simulateAndCheck(tx: Transaction, label: string): Promise<boolean> {
  const connection = getConnection()
  try {
    const sim = await connection.simulateTransaction(tx)
    if (sim.value.err) {
      const errorPayload = {
        label,
        err: sim.value.err,
        logs: sim.value.logs?.slice(-10) ?? [],
        unitsConsumed: sim.value.unitsConsumed ?? null,
      }

      console.error(`${label} ⚠ simulation FAILED — aborting send`, errorPayload)

      // Persist to bot_logs so we can actually debug these failures later
      try {
        logError('tx_simulation_failed', errorPayload)
      } catch (logErr) {
        console.error(`[simulateAndCheck] failed to write simulation failure to bot_logs`, logErr)
      }

      return false
    }
    console.log(`${label} simulation OK (units: ${sim.value.unitsConsumed ?? 'n/a'})`)
    return true
  } catch (simErr: unknown) {
    const msg = simErr instanceof Error ? simErr.message : String(simErr)
    if (msg.includes('memory allocation failed') || msg.includes('out of memory')) {
      console.error(`${label} ⚠ simulation OOM — position too large, aborting`, { error: msg })
      return false
    }
    console.warn(`${label} simulation threw (proceeding):`, msg)
    return true
  }
}

/**
 * Sends a legacy transaction and waits for confirmation.
 *
 * If confirmTransaction throws (RPC timeout, block height expiry, etc.)
 * we fall back to getSignatureStatus. If the chain shows the tx as
 * 'confirmed' or 'finalized' we treat it as success.
 */
export async function sendLegacyTx(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[],
  label: string = '[tx]',
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey

  const simOk = await simulateAndCheck(tx, label)
  if (!simOk) throw new Error(`${label} transaction aborted — simulation reported program error`)

  tx.sign(...signers)

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })

  try {
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    )
  } catch (confirmErr: unknown) {
    const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr)
    console.warn(`${label} confirmTransaction threw — checking chain directly for ${sig.slice(0, 8)}…`, errMsg)

    await new Promise(r => setTimeout(r, 3_000))

    const statusResp = await connection.getSignatureStatus(sig, { searchTransactionHistory: true })
    const status = statusResp.value

    if (
      status &&
      !status.err &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    ) {
      console.log(`${label} tx confirmed on-chain via status fallback ✔ (${status.confirmationStatus}) sig: ${sig}`)
      return sig
    }

    console.error(`${label} tx not confirmed on-chain after fallback check — sig: ${sig}`, { status })
    throw confirmErr
  }

  return sig
}

/**
 * Convenience wrapper that applies priority fee + sends.
 */
export async function sendWithPriorityFee(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[],
  priorityFee: number,
  label: string,
  fallbackUnits = 1_400_000,
): Promise<string> {
  const prepared = applyPriorityFee(tx, priorityFee, fallbackUnits)
  return sendLegacyTx(prepared, signers, label)
}