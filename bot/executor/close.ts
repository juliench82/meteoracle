/**
 * bot/executor/close.ts
 *
 * DLMM position closing logic extracted from the monolithic executor.ts.
 */

import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'

import { getConnection, getWallet } from '@/lib/solana'
// Jupiter swap removed - using direct Meteora DLMM swap for sell too
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

    // Refresh claimable from on-chain positionData (fresher than local state snapshot).
    // The removeLiquidity(shouldClaimAndClose) will claim whatever is current at remove time.
    if (userPosition?.positionData) {
      const pd = userPosition.positionData;
      const feeX = Number(pd.feeX ?? pd.fee_x ?? 0);
      const feeY = Number(pd.feeY ?? pd.fee_y ?? 0);
      // Rough USD proxy (token fees ~small; real conversion would use live price).
      claimableFeesUsd = (feeY / 1e9) + (feeX / 1e6 * 0.001);
    }

    // NOTE: explicit claimAllRewards removed — removeLiquidity with shouldClaimAndClose:true already claims fees + closes in one tx.
    // Double-claiming wasted fees and could cause on-chain issues.

    // Resolve transfer hook remaining accounts for Token-2022 (for removeLiquidity)
    let hookRemainingAccounts: any[] = []
    // Pass PublicKey (not string) for consistency with getTokenProgramId signature and other call sites
    const tokenXProgram = await getTokenProgramId(dlmmPool.tokenX.publicKey).catch(() => TOKEN_PROGRAM_ID)
    const tokenYProgram = await getTokenProgramId(dlmmPool.tokenY.publicKey).catch(() => TOKEN_PROGRAM_ID)
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
        // Pass transfer hook remaining accounts for Token-2022 (populated above if needed)
        ...(hookRemainingAccounts.length > 0 ? { remainingAccounts: hookRemainingAccounts } : {}),
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
        // Direct DLMM sell (Meteora native) - ditching Jupiter completely.
        const tokenMint = new PublicKey(position.mint)
        const isTokenX = dlmmPool.tokenX.publicKey.toBase58() === position.mint
        const inToken = isTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey
        const outToken = isTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey
        const binArrays = await dlmmPool.getBinArrays()

        const tokenProgramId = await getTokenProgramId(tokenMint)
        const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, tokenProgramId)
        const balResp = await connection.getTokenAccountBalance(tokenAta).catch(() => null)
        const amount = new BN(balResp?.value?.amount ?? '0')

        if (!amount.isZero()) {
          const activeBinAtSell = await dlmmPool.getActiveBin();
          console.log(`${label} [direct-dlmm-sell] activeBin=${activeBinAtSell.binId}, in=${inToken.toBase58().slice(0,8)}, out=${outToken.toBase58().slice(0,8)}, amount=${amount}`);

          // swapYtoX: true if swapping from Y to X
          const swapYtoX = (inToken.toBase58() === dlmmPool.tokenY.publicKey.toBase58())
          const swapQuote = await dlmmPool.swapQuote(
            amount,
            swapYtoX,
            new BN(1),
            binArrays
          )
          const q = swapQuote as any;
          if (q.outAmount.isZero()) {
            throw new Error('Direct DLMM sell quote gave 0 output')
          }
          console.log(`${label} [direct-dlmm-sell] quote: in=${q.inAmount} out=${q.outAmount} fee=${q.fee}`);

          const swapTx = await dlmmPool.swap({
            inToken,
            binArraysPubkey: q.binArraysPubkey,
            inAmount: q.inAmount,
            lbPair: dlmmPool.pubkey,
            user: wallet.publicKey,
            minOutAmount: q.minOutAmount,
            outToken,
          })
          const sig = await sendLegacyTx(applyPriorityFee(swapTx, 100000), [wallet], label)
          console.log(`${label} direct DLMM sell confirmed ✔ sig: ${sig}`);

          // Post-sell balance debug
          try {
            const postBal = await connection.getTokenAccountBalance(tokenAta).catch(() => null);
            console.log(`${label} [direct-dlmm-sell] post-sell balance for ${inToken.toBase58().slice(0,8)}: ${postBal?.value?.amount ?? '0'}`);
          } catch {}
        }
      } catch (swapErr) {
        console.error(`${label} direct DLMM sell failed — marking sell_failed for stranded recovery`, swapErr)
        // LP liquidity has been removed; flag for background stranded sell retry (monitor will pick up).
        // Recovery relies on the sell_failed marker + balance sweep in retryStrandedSells.
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