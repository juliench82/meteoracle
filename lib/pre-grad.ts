// lib/pre-grad.ts
import { Keypair, PublicKey } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { getConnection, getWallet } from '@/lib/solana';
import { createServerClient } from '@/lib/supabase';
import { sendAlert } from '@/bot/alerter';

const PRE_GRAD_MAX_POSITIONS = parseInt(process.env.PRE_GRAD_MAX_POSITIONS ?? '2');
const PRE_GRAD_SOL_USD = parseInt(process.env.PRE_GRAD_SOL_USD ?? '50');
const PRE_GRAD_CLOSE_AFTER_MIN = 45;

export async function fetchSolPriceUsd(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      'https://price.jup.ag/v4/price?ids=So11111111111111111111111111111111111111112',
      {
        headers: { 'x-api-key': process.env.JUPITER_API_KEY ?? '' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error('Jupiter price fetch failed');
    const data = await res.json();
    return data.data?.So11111111111111111111111111111111111111112?.price ?? 150;
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[pre-grad] Jupiter price fetch failed, using fallback 150', err);
    return 150;
  }
}

export async function createPreGradPool(params: {
  mintAddress: string;
  symbol: string;
  strategy: unknown;
}): Promise<string | null> {
  const { mintAddress, symbol } = params;
  const supabase = createServerClient();

  const { count } = await supabase
    .from('lp_positions')
    .select('*', { count: 'exact', head: true })
    .eq('position_type', 'pre_grad')
    .eq('status', 'open');

  if ((count ?? 0) >= PRE_GRAD_MAX_POSITIONS) {
    console.log(`[pre-grad] cap reached (${count}/${PRE_GRAD_MAX_POSITIONS}) — skipping ${symbol}`);
    return null;
  }

  const solPrice = await fetchSolPriceUsd();
  const solAmount = PRE_GRAD_SOL_USD / solPrice;

  const connection = getConnection();
  const wallet = getWallet();

  try {
    const pool = await CpAmm.createPool({
      connection,
      wallet,
      tokenAMint: new PublicKey(mintAddress),
      tokenBMint: new PublicKey('So11111111111111111111111111111111111111112'),
      tokenAAmount: 0,
      tokenBAmount: Math.floor(solAmount * 1e9),
      baseFee: {
        cliffFeeNumerator: new BN(60_000_000), // 6.0%
        numberOfPeriod: 10,
        reductionFactor: new BN(550_000),
        periodFrequency: new BN(3_600),
        feeSchedulerMode: 1,
      },
      dynamicFee: null,
    });

    const poolAddress = pool.poolAddress.toString();

    await supabase.from('lp_positions').insert({
      position_type: 'pre_grad',
      mint: mintAddress,
      symbol,
      pool_address: poolAddress,
      status: 'open',
      created_at: new Date().toISOString(),
      metadata: { sol_amount: solAmount, fee_start: 6.0, strategy: 'pre_grad' },
    });

    await sendAlert({
      type: 'pre_grad_pool_created',
      symbol,
      mint: mintAddress,
      pool: poolAddress,
      sol: solAmount,
    });

    console.log(`[pre-grad] ✅ ${symbol} DAMM v2 pool ${poolAddress}`);
    return poolAddress;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pre-grad] ❌ create failed ${symbol}`, err);
    await sendAlert({ type: 'pre_grad_create_failed', mint: mintAddress, error: message });
    return null;
  }
}

export async function closePreGradPosition(position: Record<string, unknown>): Promise<boolean> {
  const ageMs = Date.now() - new Date(position.created_at as string).getTime();
  if (ageMs < PRE_GRAD_CLOSE_AFTER_MIN * 60 * 1000) return false;

  const supabase = createServerClient();
  const label = `[pre-grad][close][${position.id}]`;

  const connection = getConnection();
  const wallet = getWallet();

  try {
    await CpAmm.removeLiquidity({
      connection,
      wallet,
      poolAddress: new PublicKey(position.pool_address as string),
    });

    await supabase
      .from('lp_positions')
      .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: 'time_decay' })
      .eq('id', position.id);

    await sendAlert({
      type: 'pre_grad_closed',
      symbol: position.symbol as string,
      positionId: String(position.id),
      ageMin: Math.round(ageMs / 60_000),
      reason: 'time_decay',
    });

    console.log(`${label} closed ${position.symbol}`);
    return true;
  } catch (err) {
    console.error(`${label} close failed`, err);
    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'pre_grad_close_failed',
      payload: { positionId: position.id, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
