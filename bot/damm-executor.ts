/**
 * bot/damm-executor.ts — DAMM v2 position open / close.
 *
 * Uses @meteora-ag/cp-amm-sdk (CpAmm) exclusively.
 * COMPLETELY ISOLATED from bot/executor.ts (DLMM) — zero shared imports.
 *
 * ISOLATION RULE: Must NOT import from bot/executor.ts or bot/monitor.ts.
 *
 * CRITICAL: CpAmm and Connection are lazy-initialised inside functions only.
 * Module-level SDK instantiation triggers Anchor IDL parsing at Next.js build
 * time, which crashes page-data collection with an IdlError.
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { Connection } from '@solana/web3.js'
import type { DammPositionParams } from '@/lib/types'

// ── Lazy singleton ─────────────────────────────────────────────────────────────
// Never instantiate at module level — that runs during Next.js build and causes
// Anchor IDL parsing to fire, crashing /api/bot/tick page-data collection.

let _cpAmm: import('@meteora-ag/cp-amm-sdk').CpAmm | null = null

async function getCpAmm(): Promise<import('@meteora-ag/cp-amm-sdk').CpAmm> {
  if (!_cpAmm) {
    const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')
    const conn = new Connection(process.env.RPC_URL ?? process.env.HELIUS_RPC_URL ?? '')
    _cpAmm = new CpAmm(conn)
  }
  return _cpAmm
}

// ── Open ───────────────────────────────────────────────────────────────────────

/**
 * Open a DAMM v2 position for the given token/pool.
 *
 * Real implementation steps (all marked TODO below):
 *   1. Fetch pool state via cpAmm to confirm pool is live.
 *   2. Derive a position Keypair.
 *   3. Build a single-sided SOL deposit instruction (conservative price range).
 *   4. Send + confirm the transaction.
 *   5. Write the position row to lp_positions (strategy_id='damm-edge').
 */
export async function openDammPosition(
  params: DammPositionParams
): Promise<{ positionPubkey: string; txSignature: string; success: boolean; error?: string }> {
  console.log('[DAMM] Would open position for', params.tokenAddress)
  console.log(
    `[DAMM] pool=${params.poolAddress}, sol=${params.solAmount}, ` +
    `age=${params.ageMinutes.toFixed(1)}min, feeTvl=${params.feeTvl24hPct.toFixed(1)}%`
  )

  try {
    // Lazy-load SDK — safe to call here (runtime only, never at build time)
    const cpAmm = await getCpAmm()
    void cpAmm // suppress unused-variable lint until TODOs are implemented

    // TODO (step 1): Confirm pool exists and is not paused.
    //   const poolState = await cpAmm.fetchPoolState(new PublicKey(params.poolAddress))

    // TODO (step 2): Derive a fresh position Keypair.
    //   const positionKp = Keypair.generate()

    // TODO (step 3): Build single-sided deposit IX (SOL only — token not yet graduated).
    //   Conservative price range: e.g. ±30% around current active bin.
    //   Reference: cpAmm.addLiquidity() or cpAmm.createPositionAndAddLiquidityByStrategy()

    // TODO (step 4): Set compute budget, build + sign transaction, send + confirm.

    // TODO (step 5): Insert row into lp_positions:
    //   { strategy_id: 'damm-edge', position_type: 'damm_edge', status: 'active', ... }

    // ── STUB: returns success so the scanner hook + DB flow can be tested end-to-end ──
    return {
      positionPubkey: 'DAMM_STUB_' + Date.now(),
      txSignature:    'DAMM_TX_STUB',
      success:        true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DAMM] openDammPosition failed:', msg)
    return { positionPubkey: '', txSignature: '', success: false, error: msg }
  }
}

// ── Close ──────────────────────────────────────────────────────────────────────

/**
 * Close an existing DAMM v2 position.
 *
 * Real implementation steps (all marked TODO below):
 *   1. Fetch position account state via cpAmm.
 *   2. Claim any pending fees (claimFee / claimAllFee).
 *   3. Remove all liquidity (removeLiquidity / decreaseLiquidityByStrategy).
 *   4. Close the position account to reclaim rent.
 *   5. If any token balance remains, swap token → SOL via Jupiter.
 *   6. Update lp_positions: status='closed', close_reason, closed_at, fees_earned_sol.
 */
export async function closeDammPosition(
  positionPubkey: string,
  reason: string
): Promise<{ txSignature: string; success: boolean; error?: string }> {
  console.log('[DAMM] Would close', positionPubkey, 'reason:', reason)

  try {
    const cpAmm = await getCpAmm()
    void cpAmm

    // TODO (step 1): const positionState = await cpAmm.fetchPositionState(new PublicKey(positionPubkey))
    // TODO (step 2): Claim fees IX — cpAmm.claimFee() or cpAmm.claimAllFee()
    // TODO (step 3): Remove liquidity IX — cpAmm.removeLiquidity() or decreaseLiquidityByStrategy()
    // TODO (step 4): Close position account IX to reclaim rent
    // TODO (step 5): Swap residual token → SOL if needed (Jupiter quote + swap)
    // TODO (step 6): Update lp_positions in Supabase: status='closed', close_reason, closed_at, fees_earned_sol

    // ── STUB ──
    return { txSignature: 'CLOSE_STUB', success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DAMM] closeDammPosition failed:', msg)
    return { txSignature: '', success: false, error: msg }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Fetch and validate pool config from the DAMM v2 pool account.
 * Used to confirm the pool is live and to read fee/price parameters before opening.
 *
 * TODO: Replace stub with real cpAmm.fetchPoolState() call.
 */
export async function getDammPoolConfig(poolAddress: string): Promise<{
  isValid: boolean
  currentPrice?: number
  feePct?: number
}> {
  // TODO: const cpAmm = await getCpAmm()
  // TODO: const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress))
  // TODO: return { isValid: true, currentPrice: poolState.sqrtPrice, feePct: poolState.poolFees.baseFactor }
  void poolAddress
  return { isValid: true }
}
