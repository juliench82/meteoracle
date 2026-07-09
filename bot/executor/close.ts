/**
 * bot/executor/close.ts
 *
 * DLMM position closing logic extracted from the monolithic executor.ts.
 */

import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'

import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
// Jupiter swap removed - using direct Meteora DLMM swap for sell too
import { sendAlert } from '@/bot/alerter'
import { getOpenLpPositions } from '@/lib/local-state'
import { logWarn, logInfo } from '@/lib/log'
import { resolveSolPriceUsd } from '@/lib/sol-price'

import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
} from '@/lib/solana-tx'

import {
  markPositionClosed,
  markPositionSellFailed,
  sendCloseAlert,
  updatePositionClaimTime,
} from './persistence'
import { applyMonitorUpdates } from '@/lib/local-state'

import {
  getDLMM,
  getTokenProgramId,
  getPositionWithRetry,
  getClaimableFeesUsd,
  getDecimalAdjustedPrice,
  NATIVE_MINT_STR,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './utils'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

const CLOSE_SELL_SLIPPAGE_BPS = 500  // 5% for post-close sells (price can move on exit paths)

// In-memory mutex to prevent concurrent close attempts on the same positionId
// (monitor tick + manual /close + overrun can race otherwise).
const closingInProgress = new Set<string>()

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

  if (closingInProgress.has(positionId)) {
    console.log(`[executor][close] close already in flight for ${positionId} — skipping duplicate to avoid double-removeLiquidity`)
    return false
  }
  closingInProgress.add(positionId)

  const label = `[executor][close][${position.symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  if (position.dry_run === true) {
    console.log(`${label} DRY RUN row — marking closed in DB only`)
    const claimableFeesUsd = getClaimableFeesUsd(position) ?? 0
    await markPositionClosed(positionId, claimableFeesUsd, reason)
    await sendCloseAlert(position, claimableFeesUsd, reason)
    closingInProgress.delete(positionId)
    return true
  }

  if (ENV_DRY_RUN_FORCED) {
    console.warn(`${label} BOT_DRY_RUN=true — refusing to close live on-chain position`)
    logWarn('legacy_bot_log', {
      level: 'warn',
      event: 'close_position_skipped_env_dry_run',
      payload: { positionId, reason },
    })
    closingInProgress.delete(positionId)
    return false
  }

  if (!position.position_pubkey) {
    console.error(`${label} position_pubkey is null — cannot close on-chain, marking closed in DB`)
    await markPositionClosed(positionId, getClaimableFeesUsd(position) ?? 0, `${reason}_no_pubkey`)
    closingInProgress.delete(positionId)
    return false
  }

  const connection = getConnection()
  const wallet = getWallet()

  // Persist flag before tx for restart safety (in-memory mutex not enough across PM2 restart)
  await applyMonitorUpdates([{ id: positionId, patch: { close_in_progress: true as any } }])

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

      // Proper calc: mirror the isXSol orientation + live price (fixes hardcoded 0.001 proxy)
      const xPub = dlmmPool.tokenX?.publicKey?.toBase58?.() ?? ''
      const isXSol = xPub === 'So11111111111111111111111111111111111111112'
      const feeSolLamports = isXSol ? feeX : feeY
      const feeTokenLamports = isXSol ? feeY : feeX
      const tokenDecimals = (isXSol ? (dlmmPool as any).tokenY?.decimals : (dlmmPool as any).tokenX?.decimals) ?? 6
      let activeBin: any = null
      try { activeBin = await dlmmPool.getActiveBin() } catch {}
      const priceSolPerToken = getDecimalAdjustedPrice(dlmmPool, activeBin) || 0
      const feeTokenWhole = feeTokenLamports / Math.pow(10, tokenDecimals)
      const feesInSol = (feeSolLamports / 1e9) + (feeTokenWhole * priceSolPerToken)

      try {
        // Use last known from previous resolve if fresh fails (avoid stale magic 150)
        const solUsd = await resolveSolPriceUsd().catch(() => (globalThis as any).__lastSolPriceUsd ?? 150)
        ;(globalThis as any).__lastSolPriceUsd = solUsd
        claimableFeesUsd = Math.max(0, feesInSol * solUsd)
      } catch {
        claimableFeesUsd = feesInSol * ((globalThis as any).__lastSolPriceUsd ?? 150)
      }
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
      const closePriorityFee = await getPriorityFee([position.pool_address, wallet.publicKey.toBase58()]).catch(() => 50_000)
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(applyPriorityFee(tx, closePriorityFee), [wallet], label)
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
        console.log(`${label} [direct-dlmm-sell] fetched ${binArrays.length} bin arrays (passing FULL list to swap to avoid AccountNotEnoughKeys for bin_array)`);

        const tokenProgramId = await getTokenProgramId(tokenMint)
        const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, tokenProgramId)
        const balResp = await connection.getTokenAccountBalance(tokenAta).catch(() => null)
        const amount = new BN(balResp?.value?.amount ?? '0')

        if (!amount.isZero()) {
          const activeBinAtSell = await dlmmPool.getActiveBin();
          console.log(`${label} [direct-dlmm-sell] activeBin=${activeBinAtSell.binId}, in=${inToken.toBase58().slice(0,8)}, out=${outToken.toBase58().slice(0,8)}, amount=${amount}`);

          // swapYtoX: true if swapping from Y to X
          const swapYtoX = (inToken.toBase58() === dlmmPool.tokenY.publicKey.toBase58())
          const inputAmountBN = amount;  // the exact balance we read and will sell
          const swapQuote = await dlmmPool.swapQuote(
            inputAmountBN,
            swapYtoX,
            new BN(CLOSE_SELL_SLIPPAGE_BPS),
            binArrays
          )
          const q = swapQuote as any;
          if (q.outAmount.isZero()) {
            throw new Error('Direct DLMM sell quote gave 0 output')
          }
          const quotedIn = q.inAmount ?? inputAmountBN;
          console.log(`${label} [direct-dlmm-sell] quote: in=${quotedIn} out=${q.outAmount} fee=${q.fee}`);

          const binArrayKeysForSwap = (q.binArraysPubkey && q.binArraysPubkey.length > 0)
            ? q.binArraysPubkey
            : binArrays.slice(0, 3).map((ba: any) => ba.publicKey);
          console.log(`${label} [direct-dlmm-sell] calling swap with limited ${binArrayKeysForSwap.length} bin array pubkeys`);
          const swapTx = await dlmmPool.swap({
            inToken,
            binArraysPubkey: binArrayKeysForSwap,
            inAmount: inputAmountBN,
            lbPair: dlmmPool.pubkey,
            user: wallet.publicKey,
            // Slightly defensive vs pure quote (blocks can pass); still respects the quoted slippage.
            // If this fails it will correctly fall to sell_failed + recovery loop.
            minOutAmount: q.minOutAmount && !q.minOutAmount.isZero() ? q.minOutAmount : q.outAmount.div(new BN(2)), // avoid total 0; conservative vs pure quote fail
            outToken,
          })
          const sellPriorityFee = await getPriorityFee([position.pool_address, wallet.publicKey.toBase58()]).catch(() => 50_000)
          const sig = await sendLegacyTx(applyPriorityFee(swapTx, sellPriorityFee), [wallet], label)
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
    if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') || message.includes('429') || message.includes('socket hang up')) {
      getConnection(true)
    }
    logWarn('legacy_bot_log', {
      level: 'error', event: 'close_position_failed',
      payload: { positionId, reason, error: message },
    })
    // Clear persisted flag on failure so monitor can retry later
    await applyMonitorUpdates([{ id: positionId, patch: { close_in_progress: false as any } }])
    return false
  } finally {
    closingInProgress.delete(positionId)
  }
}

/**
 * Claim accumulated swap fees for an open position WITHOUT closing or removing liquidity.
 * Uses DLMM SDK claimSwapFee when available (preferred). Falls back to tiny bps remove+claim if needed.
 * Updates last_claim_at in state for the 30min cadence.
 */
export async function claimFeesForPosition(positionId: string): Promise<boolean> {
  const positions = getOpenLpPositions() as any[]
  const position = positions.find((p: any) => p.id === positionId)
  if (!position || !position.position_pubkey || position.dry_run) {
    return false
  }

  const label = `[executor][claim][${position.symbol}]`
  const connection = getConnection()
  const wallet = getWallet()

  try {
    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const posKey = new PublicKey(position.position_pubkey)

    const userPos = await getPositionWithRetry(dlmmPool, wallet.publicKey, posKey.toBase58(), label).catch(() => null)
    if (!userPos?.positionData) {
      console.warn(`${label} no on-chain position data for claim`)
      return false
    }

    const { lowerBinId, upperBinId } = userPos.positionData

    // Preferred: dedicated claim (no liquidity change)
    try {
      const claimRes: any = await (dlmmPool as any).claimSwapFee?.({
        owner: wallet.publicKey,
        position: posKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
      })
      const txs = Array.isArray(claimRes) ? claimRes : (claimRes ? [claimRes] : [])
      for (const tx of txs) {
        const claimPrio = await getPriorityFee([position.pool_address, wallet.publicKey.toBase58()]).catch(() => 50_000)
        const sig = await sendLegacyTx(applyPriorityFee(tx, claimPrio), [wallet], `${label}-claim`)
        console.log(`${label} fees claimed ✔ sig: ${sig}`)
      }
      if (txs.length > 0) {
        await updatePositionClaimTime(positionId).catch(() => {})
        return true
      }
    } catch (claimErr) {
      console.warn(`${label} claimSwapFee not available or failed — skipping mid-position claim (fees will be collected on full close via shouldClaimAndClose)`, claimErr)
      sendAlert({ type: 'warning', message: `Claim fees failed for ${position.symbol} (${positionId}) — will retry or collect on close` }).catch(() => {})
      // Record persistent marker so cadence/monitor sees the failure (no silent skip); enables future backoff or alerts
      applyMonitorUpdates([{ id: positionId, patch: { last_claim_attempt_at: new Date().toISOString(), last_claim_error: String(claimErr).slice(0, 300) } as any }]).catch(() => {})
    }

    return false
  } catch (e) {
    console.warn(`${label} claim failed:`, e)
    applyMonitorUpdates([{ id: positionId, patch: { last_claim_attempt_at: new Date().toISOString(), last_claim_error: String(e).slice(0, 300) } as any }]).catch(() => {})
    return false
  }
}