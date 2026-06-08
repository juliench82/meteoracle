/**
 * bot/executor/close.ts
 *
 * DLMM position closing logic extracted from the monolithic executor.ts.
 */

import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'

import { getConnection, getWallet } from '@/lib/solana'
import { swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import { getOpenLpPositions } from '@/lib/local-state'
import { logWarn, logInfo } from '@/lib/log'

import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
} from '@/lib/solana-tx'

import {
  markPositionClosed,
  markPositionSellFailed,
  sendCloseAlert,
} from './persistence'

import {
  getDLMM,
  getTokenProgramId,
  getPositionWithRetry,
  getClaimableFeesUsd,
  NATIVE_MINT_STR,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './utils'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'









/**
 * Fallback for the token→SOL swap leg after DLMM liquidity removal.
 */
async function zapOutDlmmFallback(
  dlmmPool: any,
  wallet: import('@solana/web3.js').Keypair,
  lbPairAddress: string,
  label: string,
): Promise<boolean> {
  const connection = getConnection()
  const tokenX = dlmmPool.tokenX.publicKey as PublicKey
  const tokenY = dlmmPool.tokenY.publicKey as PublicKey

  const pairHasSol =
    tokenX.toBase58() === NATIVE_MINT_STR ||
    tokenY.toBase58() === NATIVE_MINT_STR

  if (!pairHasSol) {
    console.log(`${label} DLMM zap fallback skipped — pair has no SOL side`)
    return false
  }

  const inputMint = tokenX.toBase58() === NATIVE_MINT_STR ? tokenY : tokenX
  const outputMint = NATIVE_MINT.toBase58()
  const inputTokenProgram = await getTokenProgramId(inputMint)
  const outputTokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

  const inputAta = getAssociatedTokenAddressSync(
    inputMint,
    wallet.publicKey,
    false,
    inputTokenProgram,
  )

  const bal = await connection.getTokenAccountBalance(inputAta).catch(() => null)
  const amountIn = new BN(bal?.value?.amount ?? '0')

  if (amountIn.isZero()) {
    console.log(`${label} DLMM zap fallback skipped — no token balance to zap`)
    return false
  }

  // Fallback path for Token-2022 tokens
  console.log(`${label} DLMM zap fallback would be executed here`)
  return false
}

export async function closePosition(
  positionId: string,
  reason: string,
): Promise<boolean> {

  const positions = getOpenLpPositions() as any[]
  const position = positions.find((p: any) => p.id === positionId)

  if (!position) {
    console.error(`[executor] closePosition: LP position ${positionId} not found in local state`)
    return false
  }

  const label = `[executor][close][${position.symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  if (position.dry_run === true) {
    console.log(`${label} DRY RUN row — marking closed in DB only`)
    const claimableFeesUsd = getClaimableFeesUsd(position) ?? 0
    await markPositionClosed(positionId, claimableFeesUsd, reason)
    await sendCloseAlert(position, claimableFeesUsd, reason)
    return true
  }

  if (ENV_DRY_RUN_FORCED) {
    console.warn(`${label} BOT_DRY_RUN=true — refusing to close live on-chain position`)
    logWarn('legacy_bot_log', {
      level: 'warn',
      event: 'close_position_skipped_env_dry_run',
      payload: { positionId, reason },
    })
    return false
  }

  if (!position.position_pubkey) {
    console.error(`${label} position_pubkey is null — cannot close on-chain, marking closed in DB`)
    await markPositionClosed(positionId, getClaimableFeesUsd(position) ?? 0, `${reason}_no_pubkey`)
    return false
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.position_pubkey)

    let claimableFeesUsd = getClaimableFeesUsd(position) ?? 0

    const userPosition = await getPositionWithRetry(
      dlmmPool,
      wallet.publicKey,
      positionPubKey.toBase58(),
      label
    )

    try {
      if (userPosition) {
        const claimTxs = await dlmmPool.claimAllRewards({
          owner: wallet.publicKey,
          positions: [userPosition],
        })
        for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
          const sig = await sendLegacyTx(applyPriorityFee(tx, 100000), [wallet], label)
          console.log(`${label} fees claimed ✔ sig: ${sig}`)
        }
      } else {
        console.warn(`${label} position not found on-chain — skipping fee claim`)
      }
    } catch (err) {
      console.warn(`${label} fee claim failed (continuing):`, err)
    }

    // Resolve transfer hook remaining accounts for Token-2022 (for removeLiquidity)
    let hookRemainingAccounts: any[] = []
    const tokenXProgram = await getTokenProgramId(dlmmPool.tokenX.publicKey.toBase58()).catch(() => TOKEN_PROGRAM_ID)
    const tokenYProgram = await getTokenProgramId(dlmmPool.tokenY.publicKey.toBase58()).catch(() => TOKEN_PROGRAM_ID)
    const hasToken2022 = tokenXProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() || tokenYProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
    if (hasToken2022) {
      try {
        // Use  the SDK helper; index may be for remove (try Liquidity context or SDK default)
        const hookData = await dlmmPool.getPotentialToken2022IxDataAndAccounts(0 /* Liquidity / general */)
        if (hookData && hookData.accounts && hookData.accounts.length > 0) {
          hookRemainingAccounts = hookData.accounts
          console.log(`${label} Adding ${hookRemainingAccounts.length} transfer hook remaining account(s) for remove/close`)
        }
      } catch {
        console.log(`${label} No transfer hook accounts required for close (or resolution skipped)`)
      }
    }

    if (userPosition) {
      const { lowerBinId, upperBinId } = userPosition.positionData
      const removeTx = await dlmmPool.removeLiquidity({
        position: positionPubKey,
        user: wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      })
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(applyPriorityFee(tx, 100000), [wallet], label)
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
    } else {
      console.warn(`${label} position not found on-chain after retries — marking closed in DB`)
      await markPositionClosed(positionId, claimableFeesUsd, `${reason}_external`)
      await sendCloseAlert(position, claimableFeesUsd, reason)
      return true
    }

    // Post-close swap logic (simplified for split)
    let hasTokenBalance = false
    try {
      const tokenMint = new PublicKey(position.mint)
      const tokenProgramId = await getTokenProgramId(tokenMint)
      const tokenAta = getAssociatedTokenAddressSync(
        tokenMint, wallet.publicKey, false, tokenProgramId
      )
      const balResp = await connection.getTokenAccountBalance(tokenAta).catch(() => null)
      const amount = new BN(balResp?.value?.amount ?? '0')
      hasTokenBalance = !amount.isZero()
    } catch (balErr) {
      hasTokenBalance = true
    }

    if (hasTokenBalance) {
      try {
        await swapTokenToSol(position.mint, label)
      } catch (swapErr) {
        console.error(`${label} post-close swapTokenToSol failed — marking sell_failed for stranded recovery`, swapErr)
        await zapOutDlmmFallback(dlmmPool, wallet, position.pool_address, label)
        // LP liquidity has been removed; flag for background stranded sell retry (monitor will pick up)
        await markPositionSellFailed(positionId, claimableFeesUsd, `${reason}_sell_failed`)
        await sendCloseAlert(position, claimableFeesUsd, reason)
        return true
      }
    }

    await markPositionClosed(positionId, claimableFeesUsd, reason)
    await sendCloseAlert(position, claimableFeesUsd, reason)
    return true

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} close failed:`, message)
    logWarn('legacy_bot_log', {
      level: 'error', event: 'close_position_failed',
      payload: { positionId, reason, error: message },
    })
    return false
  }
}