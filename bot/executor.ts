import DLMM, { StrategyType } from '@meteora-ag/dlmm'
import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token'
import BN from 'bn.js'
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import type { Strategy, TokenMetrics } from '@/lib/types'

const DRY_RUN = process.env.BOT_DRY_RUN === 'true'
// Actual rent for a Meteora position account is ~0.057 SOL.
// We reserve 0.07 SOL as headroom (balance check only — NOT passed to SDK).
const METEORA_RENT_RESERVE_SOL = 0.07
const NATIVE_MINT_STR = NATIVE_MINT.toBase58()

function toIxArray(ix: TransactionInstruction | TransactionInstruction[]): TransactionInstruction[] {
  return Array.isArray(ix) ? ix : [ix]
}

async function sendLegacyTx(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[]
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  const connection = getConnection()
  const info = await connection.getAccountInfo(mint)
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID
  }
  return TOKEN_PROGRAM_ID
}

export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return await persistPosition(metrics, strategy, 'dry-run-sig', 0, 0)
  }

  const connection = getConnection()
  const wallet = getWallet()
  const supabase = createServerClient()

  try {
    // 1. Balance check — reserve is for headroom only, SDK gets exactly solAmount
    const maxSol = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.1')
    const solAmount = Math.min(strategy.position.maxSolPerPosition, maxSol)
    const balanceLamports = await connection.getBalance(wallet.publicKey)
    const balanceSol = balanceLamports / 1e9
    console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`)

    const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL
    if (balanceSol < requiredSol) {
      console.warn(`${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)} SOL`)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_insufficient_balance',
        payload: { symbol: metrics.symbol, balanceSol, requiredSol },
      })
      return null
    }

    // 2. Load pool + derive token mints
    const dlmmPool = await DLMM.create(connection, new PublicKey(metrics.poolAddress))
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId
    // entryPriceSol is SOL-per-token — used by monitor for correct pricePct calculation
    const entryPriceSol = parseFloat(activeBin.pricePerToken)
    const binStep = dlmmPool.lbPair.binStep

    const mintX = dlmmPool.tokenX.publicKey
    const mintY = dlmmPool.tokenY.publicKey
    const isSolPool = mintY.toBase58() === NATIVE_MINT_STR

    // 3. Ensure ATAs exist
    const ataIxs: TransactionInstruction[] = []

    for (const [label_token, mint] of [['X', mintX], ['Y', mintY]] as [string, PublicKey][]) {
      if (mint.toBase58() === NATIVE_MINT_STR) {
        console.log(`${label} token ${label_token} is native SOL — skipping ATA creation`)
        continue
      }

      const tokenProgramId = await getTokenProgramId(mint)
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID)
      const ataInfo = await connection.getAccountInfo(ata)

      if (!ataInfo) {
        console.log(`${label} creating ATA for token ${label_token} (${mint.toBase58().slice(0, 8)}...) program=${tokenProgramId.toBase58().slice(0, 8)}`)
        ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, ata, wallet.publicKey, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        ))
      }
    }

    if (ataIxs.length > 0) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ...ataIxs
      )
      const ataSig = await sendLegacyTx(ataTx, [wallet])
      console.log(`${label} ATA(s) created ✔ sig: ${ataSig}`)
    }

    // 4. Bin range
    const binsDown = Math.abs(Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10_000)))
    const binsUp = Math.round((strategy.position.rangeUpPct / 100) / (binStep / 10_000))
    const minBinId = activeBinId - binsDown
    const maxBinId = activeBinId + binsUp
    console.log(`${label} bin range: ${minBinId} → ${maxBinId} (${binsDown + binsUp} bins, step=${binStep})`)

    // 5. Liquidity amounts — SDK receives ONLY solAmount, rent is handled by SDK internally
    const lamports = Math.floor(solAmount * 1e9)
    let totalX: BN
    let totalY: BN
    if (isSolPool) {
      totalX = new BN(0)
      totalY = new BN(lamports)
      console.log(`${label} one-sided SOL deposit: totalX=0, totalY=${lamports} lamports (${solAmount} SOL)`)
    } else {
      totalX = new BN(Math.floor(lamports * (1 - strategy.position.solBias)))
      totalY = new BN(Math.floor(lamports * strategy.position.solBias))
    }

    // 6. Strategy type
    const strategyTypeMap: Record<string, StrategyType> = {
      spot: StrategyType.Spot,
      curve: StrategyType.Curve,
      'bid-ask': StrategyType.BidAsk,
    }
    const strategyType = strategyTypeMap[strategy.position.distributionType] ?? StrategyType.Spot

    // 7. Priority fee
    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    // 8. Build multi-position tx(s)
    const response = await dlmmPool.initializeMultiplePositionAndAddLiquidityByStrategy(
      async (count) => Array.from({ length: count }, () => new Keypair()),
      totalX,
      totalY,
      { minBinId, maxBinId, strategyType },
      wallet.publicKey,
      wallet.publicKey,
      1
    )

    // 9. Send each segment
    let lastSig = ''
    let posIndex = 0
    const total = response.instructionsByPositions.length
    console.log(`${label} opening ${total} position segment(s)`)

    for (const { positionKeypair, initializePositionIx, addLiquidityIxs } of response.instructionsByPositions) {
      posIndex++

      const initIxs = toIxArray(initializePositionIx as TransactionInstruction | TransactionInstruction[])
      const initTx = new Transaction().add(...initIxs)
      lastSig = await sendLegacyTx(initTx, [wallet, positionKeypair])
      console.log(`${label} seg ${posIndex}/${total} init confirmed ✔ sig: ${lastSig}`)

      const liqChunks: TransactionInstruction[][] = Array.isArray(addLiquidityIxs)
        ? (addLiquidityIxs as (TransactionInstruction | TransactionInstruction[])[]).map(toIxArray)
        : [toIxArray(addLiquidityIxs as TransactionInstruction | TransactionInstruction[])]

      for (let i = 0; i < liqChunks.length; i++) {
        const liqTx = new Transaction().add(...liqChunks[i])
        lastSig = await sendLegacyTx(liqTx, [wallet])
        console.log(`${label} seg ${posIndex}/${total} liq ${i + 1}/${liqChunks.length} confirmed ✔ sig: ${lastSig}`)
      }
    }

    console.log(`${label} position opened ✔`)
    const firstPubKey = response.instructionsByPositions[0]?.positionKeypair?.publicKey?.toBase58()
    return await persistPosition(metrics, strategy, lastSig, entryPriceSol, solAmount, firstPubKey)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error', event: 'open_position_failed',
      payload: { symbol: metrics.symbol, strategy: strategy.id, error: message },
    })
    return null
  }
}

export async function closePosition(
  positionId: string,
  reason: string
): Promise<boolean> {
  const supabase = createServerClient()

  const { data: position, error } = await supabase
    .from('positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !position) {
    console.error(`[executor] closePosition: position ${positionId} not found`)
    return false
  }

  const label = `[executor][close][${position.token_symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — marking closed without on-chain tx`)
    await markPositionClosed(positionId, 0, reason)
    return true
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.metadata?.positionPubKey ?? '')

    // 1. Claim fees
    let feesClaimedSol = 0
    try {
      const claimTxs = await dlmmPool.claimAllRewards({
        owner: wallet.publicKey,
        positions: [{ publicKey: positionPubKey } as never],
      })
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const sig = await sendLegacyTx(tx, [wallet])
        console.log(`${label} fees claimed ✔ sig: ${sig}`)
      }
      feesClaimedSol = position.fees_earned_sol ?? 0
    } catch (err) {
      console.warn(`${label} fee claim failed (continuing):`, err)
    }

    // 2. Remove liquidity + close position account (reclaims rent)
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const userPosition = userPositions.find(p => p.publicKey.toBase58() === positionPubKey.toBase58())

    if (userPosition) {
      const { lowerBinId, upperBinId } = userPosition.positionData
      const removeTx = await dlmmPool.removeLiquidity({
        position: positionPubKey,
        user: wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true, // closes position account → rent returned to wallet
      })
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(tx, [wallet])
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
    } else {
      console.warn(`${label} position not found on-chain — may already be closed`)
    }

    await markPositionClosed(positionId, feesClaimedSol, reason)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} close failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error', event: 'close_position_failed',
      payload: { positionId, reason, error: message },
    })
    return false
  }
}

async function persistPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  sig: string,
  entryPriceSol: number,
  solDeposited: number,
  positionPubKey?: string
): Promise<string> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('positions')
    .insert({
      token_symbol:    metrics.symbol,
      token_address:   metrics.address,
      pool_address:    metrics.poolAddress,
      strategy_id:     strategy.id,
      bin_range_lower: entryPriceSol * (1 + strategy.position.rangeDownPct / 100),
      bin_range_upper: entryPriceSol * (1 + strategy.position.rangeUpPct / 100),
      entry_price:     entryPriceSol, // stored in SOL-per-token for consistent pricePct comparison
      sol_deposited:   solDeposited,
      fees_earned_sol: 0,
      status:          'active',
      in_range:        true,
      opened_at:       new Date().toISOString(),
      metadata: {
        sig,
        positionPubKey,
        entryPriceSol, // explicit SOL price for monitor to use
      },
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to persist position: ${error.message}`)
  return data.id
}

async function markPositionClosed(
  positionId: string,
  feesEarnedSol: number,
  reason: string
): Promise<void> {
  const supabase = createServerClient()
  await supabase
    .from('positions')
    .update({
      status:     'closed',
      closed_at:  new Date().toISOString(),
      fees_earned_sol: feesEarnedSol,
      metadata:   { closeReason: reason },
    })
    .eq('id', positionId)
}
