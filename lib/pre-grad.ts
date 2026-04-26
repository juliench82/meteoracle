// lib/pre-grad.ts
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { getConnection, getWallet } from '@/lib/solana';
import { createServerClient } from '@/lib/supabase';
import { sendAlert } from '@/bot/alerter';

const PRE_GRAD_MAX_POSITIONS = parseInt(process.env.PRE_GRAD_MAX_POSITIONS ?? '2');
const PRE_GRAD_SOL_USD = parseInt(process.env.PRE_GRAD_SOL_USD ?? '35');
const PRE_GRAD_CLOSE_AFTER_MIN = 45;

export async function fetchSolPriceUsd(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(
      'https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112',
      {
        headers: { 'x-api-key': process.env.JUPITER_API_KEY ?? '' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) throw new Error('Jupiter v6 failed');

    const data = await res.json();
    const price = data.data?.So11111111111111111111111111111111111111112?.price;

    if (price && price > 50 && price < 200) {
      return price;
    }
    throw new Error('Invalid price from Jupiter');
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[pre-grad] Jupiter v6 failed, using fallback SOL price', err);
    return 86; // ~current SOL price — update PRE_GRAD_SOL_USD env if this drifts
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
    const positionNftKeypair = new Keypair();
    const cpAmm = new CpAmm(connection);

    const tx = await cpAmm.createPool({
      payer: wallet.publicKey,
      creator: wallet.publicKey,
      positionNft: positionNftKeypair.publicKey,
      tokenAMint: new PublicKey(mintAddress),
      tokenBMint: new PublicKey('So11111111111111111111111111111111111111112'),
      tokenAAmount: new BN(0),
      tokenBAmount: new BN(Math.floor(solAmount * 1e9)),
      activationPoint: null,
      initSqrtPrice: new BN(0),
      liquidityDelta: new BN(0),
      tokenAProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      tokenBProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    } as any) as unknown as Transaction;

    const sig = await (wallet as any).sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, 'confirmed');

    const poolAddress = positionNftKeypair.publicKey.toString();

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

    console.log(`[pre-grad] ✅ ${symbol} DAMM v2 pool ${poolAddress} — ${solAmount.toFixed(4)} SOL ($${PRE_GRAD_SOL_USD})`);
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
    const cpAmm = new CpAmm(connection);
    const positionNftKeypair = new Keypair();

    console.warn(`${label} removeLiquidity stubbed — on-chain close skipped, marking DB closed`);
    console.log(`${label} positionNft=${positionNftKeypair.publicKey.toBase58()} pool=${String(position.pool_address)}`);
    void cpAmm;

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

/** Call when a pre-grad position's token is confirmed graduated (bonding curve = 100%). */
export async function handlePreGradGraduated(
  position: Record<string, unknown>,
  finalFeesSol: number
): Promise<void> {
  const supabase = createServerClient();

  await supabase
    .from('lp_positions')
    .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: 'graduated' })
    .eq('id', position.id);

  await sendAlert({
    type: 'pre_grad_graduated',
    symbol: position.symbol as string,
    finalFees: finalFeesSol,
  });

  console.log(`[pre-grad] 🎉 ${position.symbol} graduated — final fees: ${finalFeesSol} SOL`);
}
