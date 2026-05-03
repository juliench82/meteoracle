/**
 * bot/damm-launch-executor.ts - Creates a brand-new DAMM v2 pool and seeds liquidity.
 *
 * This executor is isolated from damm-executor.ts. It uses cp-amm-sdk createPool(),
 * which creates the pool and the initial position in one transaction.
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import type { DammPositionParams } from '@/lib/types'
import { getBotState } from '@/lib/botState'
import { createServerClient } from '@/lib/supabase'
import { assertCanOpenLpPosition } from '@/lib/position-limits'
import { getRpcEndpointCandidates } from '@/lib/solana'
import { sendAlert } from './alerter'

const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

type CpAmmModule = typeof import('@meteora-ag/cp-amm-sdk')

export type DammLaunchParams = DammPositionParams & {
  tokenDecimals?: number
  priceUsd?: number
  initialPriceSol?: number
  quoteTokenMint?: string
  feeTvl1hPct?: number
  feeTvl5mPct?: number
  volume1h?: number
  volume5m?: number
  momentumScore?: number
}

let connection: Connection | null = null
let cpAmmInstance: any = null
let cpAmmModule: CpAmmModule | null = null

function getRpcUrl(): string {
  const url = getRpcEndpointCandidates()[0]
  if (!url) throw new Error('[DAMM-LAUNCH] RPC_URL, HELIUS_RPC_URL, or HELIUS_API_KEY is not set')
  return url
}

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(getRpcUrl(), 'confirmed')
  }
  return connection
}

function getWallet(): Keypair {
  const key = process.env.WALLET_PRIVATE_KEY
  if (!key) throw new Error('[DAMM-LAUNCH] WALLET_PRIVATE_KEY not set')
  try {
    if (key.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)))
    }
    return Keypair.fromSecretKey(bs58.decode(key))
  } catch {
    throw new Error('[DAMM-LAUNCH] WALLET_PRIVATE_KEY is invalid - must be base58 or JSON uint8 array')
  }
}

async function getCpAmm(): Promise<{ sdk: any; mod: CpAmmModule }> {
  if (!cpAmmModule) {
    cpAmmModule = await import('@meteora-ag/cp-amm-sdk')
  }
  if (!cpAmmInstance) {
    cpAmmInstance = new cpAmmModule.CpAmm(getConnection())
  }
  return { sdk: cpAmmInstance, mod: cpAmmModule }
}

async function sendWithPriority(
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const rpc = getConnection()
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey

  const hasBudget = tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))
  if (!hasBudget) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    )
  }

  tx.sign(...signers)
  const sig = await rpc.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  console.log(`${label} tx confirmed: ${sig}`)
  return sig
}

async function getBotDryRun(): Promise<boolean> {
  const botState = await getBotState()
  return process.env.BOT_DRY_RUN === 'true' || botState.dry_run
}

function getLaunchConfig(mod: CpAmmModule): PublicKey {
  const configured = process.env.DAMM_LAUNCH_CONFIG_ADDRESS ?? process.env.DAMM_CONFIG_ADDRESS
  if (configured) return new PublicKey(configured)

  const rawIndex = process.env.DAMM_LAUNCH_CONFIG_INDEX ?? '0'
  const parsedIndex = Number.parseInt(rawIndex, 10)
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new Error(`[DAMM-LAUNCH] Invalid DAMM_LAUNCH_CONFIG_INDEX: ${rawIndex}`)
  }

  console.warn(`[DAMM-LAUNCH] DAMM_LAUNCH_CONFIG_ADDRESS not set; deriving config index ${parsedIndex}`)
  const index = new BN(parsedIndex)
  return mod.deriveConfigAddress(index)
}

async function resolveTokenProgram(tokenMint: PublicKey): Promise<PublicKey> {
  const account = await getConnection().getAccountInfo(tokenMint, 'confirmed')
  if (account?.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  return TOKEN_PROGRAM_ID
}

async function saveDammLaunchPosition({
  params,
  poolAddress,
  positionPubkey,
  signature,
  solDeposited,
  entryPriceSol,
  dryRun,
}: {
  params: DammLaunchParams
  poolAddress: string
  positionPubkey: string
  signature: string
  solDeposited: number
  entryPriceSol: number
  dryRun: boolean
}): Promise<string> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .insert({
      mint: params.tokenAddress,
      symbol: params.symbol,
      pool_address: poolAddress,
      position_pubkey: positionPubkey,
      strategy_id: 'damm-launch',
      position_type: 'damm-launch',
      token_amount: 0,
      sol_deposited: solDeposited,
      entry_price_usd: params.priceUsd ?? 0,
      entry_price_sol: entryPriceSol,
      status: dryRun ? 'dry_run' : 'active',
      in_range: true,
      dry_run: dryRun,
      opened_at: new Date().toISOString(),
      tx_open: signature,
      metadata: {
        strategy_id: 'damm-launch',
        position_type: 'damm-launch',
        age_minutes: params.ageMinutes,
        fee_tvl_24h_pct: params.feeTvl24hPct,
        fee_tvl_1h_pct: params.feeTvl1hPct,
        fee_tvl_5m_pct: params.feeTvl5mPct,
        liquidity_usd: params.liquidityUsd,
        volume_1h: params.volume1h,
        volume_5m: params.volume5m,
        momentum_score: params.momentumScore,
        quote_token_mint: params.quoteTokenMint,
        scanner_initial_price_sol: params.initialPriceSol,
        seeded_single_sided_sol: true,
        ...(params.bondingCurvePct !== undefined && { bonding_curve_pct: params.bondingCurvePct }),
      },
    })
    .select('id')
    .single()

  if (error) {
    console.error('[DAMM-LAUNCH] Failed to persist lp_position:', error.message)
    throw new Error(`[DAMM-LAUNCH] Supabase insert failed: ${error.message}`)
  }

  console.log(`[DAMM-LAUNCH] lp_position saved: id=${data.id} pool=${poolAddress} dry_run=${dryRun}`)
  return data.id
}

export async function createAndOpenDammLaunch(
  params: DammLaunchParams,
): Promise<{ positionPubkey: string; poolAddress: string; txSignature: string; success: boolean; error?: string }> {
  console.log('[DAMM-LAUNCH] Creating pool + initial position for', params.tokenAddress)

  try {
    const dryRun = await getBotDryRun()
    const { sdk, mod } = await getCpAmm()
    const tokenMint = new PublicKey(params.tokenAddress)
    const tokenProgram = await resolveTokenProgram(tokenMint)
    const mintInfo = await getMint(getConnection(), tokenMint, 'confirmed', tokenProgram)
    const tokenDecimals = params.tokenDecimals ?? mintInfo.decimals
    const config = getLaunchConfig(mod)
    const configState = await sdk.fetchConfigState(config)
    const positionNftKp = Keypair.generate()

    const tokenAMint = NATIVE_MINT
    const tokenBMint = tokenMint
    const tokenAProgram = TOKEN_PROGRAM_ID
    const tokenBProgram = tokenProgram
    const pool = mod.derivePoolAddress(config, tokenAMint, tokenBMint)
    const position = mod.derivePositionAddress(positionNftKp.publicKey)

    if (await sdk.isPoolExist(pool)) {
      throw new Error(`DAMM v2 pool already exists for ${params.symbol}: ${pool.toBase58()}`)
    }

    if (!dryRun) {
      const limitState = await assertCanOpenLpPosition(MAX_CONCURRENT_POSITIONS, '[DAMM-LAUNCH]')
      console.log(
        `[DAMM-LAUNCH] LP cap ok (${limitState.effectiveOpenCount}/${MAX_CONCURRENT_POSITIONS}; ` +
        `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount})`,
      )
    }

    const lamports = Math.floor(params.solAmount * 1e9)
    if (lamports <= 0) throw new Error('[DAMM-LAUNCH] solAmount must be > 0')

    const tokenAAmount = new BN(lamports)
    const tokenBAmount = new BN(0)
    const initSqrtPrice = configState.sqrtMinPrice
    if (!initSqrtPrice.eq(configState.sqrtMinPrice)) {
      throw new Error('[DAMM-LAUNCH] single-sided pool creation requires initSqrtPrice to equal sqrtMinPrice')
    }
    const entryPriceSol = Number(mod.getPriceFromSqrtPrice(initSqrtPrice, 9, tokenDecimals).toString())
    console.log(
      `[DAMM-LAUNCH] single-sided createPool config=${config.toBase58()} pool=${pool.toBase58()} ` +
      `tokenA=SOL tokenB=${tokenMint.toBase58()} entryPriceSol=${entryPriceSol}`,
    )
    const liquidityDelta = sdk.preparePoolCreationSingleSide({
      tokenAAmount,
      minSqrtPrice: configState.sqrtMinPrice,
      maxSqrtPrice: configState.sqrtMaxPrice,
      initSqrtPrice,
      collectFeeMode: configState.collectFeeMode,
    })

    if (liquidityDelta.isZero()) {
      throw new Error('[DAMM-LAUNCH] liquidityDelta is zero - check config range and SOL amount')
    }

    if (dryRun) {
      const positionId = await saveDammLaunchPosition({
        params,
        poolAddress: pool.toBase58(),
        positionPubkey: position.toBase58(),
        signature: 'DRY_RUN',
        solDeposited: params.solAmount,
        entryPriceSol,
        dryRun: true,
      })

      await sendAlert({
        type: 'pre_grad_pool_created',
        symbol: params.symbol,
        mint: params.tokenAddress,
        pool: pool.toBase58(),
        sol: params.solAmount,
      })

      return {
        positionPubkey: positionId,
        poolAddress: pool.toBase58(),
        txSignature: 'DRY_RUN',
        success: true,
      }
    }

    const wallet = getWallet()
    const tx = await sdk.createPool({
      creator: wallet.publicKey,
      payer: wallet.publicKey,
      config,
      positionNft: positionNftKp.publicKey,
      tokenAMint,
      tokenBMint,
      initSqrtPrice,
      liquidityDelta,
      tokenAAmount,
      tokenBAmount,
      activationPoint: null,
      tokenAProgram,
      tokenBProgram,
    })

    const signature = await sendWithPriority(tx, [wallet, positionNftKp], '[DAMM-LAUNCH][create]')
    await saveDammLaunchPosition({
      params,
      poolAddress: pool.toBase58(),
      positionPubkey: position.toBase58(),
      signature,
      solDeposited: params.solAmount,
      entryPriceSol,
      dryRun,
    })

    await sendAlert({
      type: 'pre_grad_pool_created',
      symbol: params.symbol,
      mint: params.tokenAddress,
      pool: pool.toBase58(),
      sol: params.solAmount,
    })

    console.log(`[DAMM-LAUNCH] Opened pool=${pool.toBase58()} position=${position.toBase58()} tokenDecimals=${tokenDecimals}`)
    return {
      positionPubkey: position.toBase58(),
      poolAddress: pool.toBase58(),
      txSignature: signature,
      success: true,
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error('[DAMM-LAUNCH] failed:', msg)
    if (!msg.includes('already exists')) {
      await sendAlert({ type: 'pre_grad_create_failed', mint: params.tokenAddress, error: msg })
    }
    return { positionPubkey: '', poolAddress: '', txSignature: '', success: false, error: msg }
  }
}
