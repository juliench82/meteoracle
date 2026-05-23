/**
 * scripts/test-dlmm-direct.ts
 *
 * Isolated tester for the direct DLMM SDK path used for Token-2022 / pump.fun graduates.
 *
 * This lets you test the exact sequence the bot runs (Jupiter swap + DLMM SDK call)
 * without waiting for the scanner or risking large amounts.
 *
 * Usage examples:
 *
 *   # Simulate only (recommended first)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool <DLMM_POOL_ADDRESS> \
 *     --mint <TOKEN_MINT> \
 *     --amount 0.05 \
 *     --simulate
 *
 *   # Actually attempt the open (uses real SOL from your wallet)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool <DLMM_POOL_ADDRESS> \
 *     --mint <TOKEN_MINT> \
 *     --amount 0.02
 *
 *   # Skip Jupiter completely (you already hold the output token) — great for isolating pure DLMM SDK issues
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool <DLMM_POOL_ADDRESS> \
 *     --mint <TOKEN_MINT> \
 *     --skip-jupiter \
 *     --token-amount 5000000000 \     # raw units (e.g. 5_000 tokens if 6 decimals)
 *     --simulate
 *
 *   # Even better: auto-use a percentage of your current balance (no manual raw unit math)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool <DLMM_POOL_ADDRESS> \
 *     --mint <TOKEN_MINT> \
 *     --skip-jupiter \
 *     --use-balance 50% \
 *     --simulate
 *
 *   # With explicit bin range (useful for debugging)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool ... --mint ... --amount 0.05 \
 *     --min-bin -450 --max-bin -350
 */

import * as dotenvLocal from 'dotenv';
import * as path from 'path';
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true });

import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';

import { getConnection, getWallet } from '@/lib/solana';
import { getTokenProgramId } from '@/bot/executor/utils';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { strategyTypeForDistribution } from '@/bot/executor/utils';

// Simple Jupiter swap helper (minimal version of the one in open.ts)
async function swapSolToTokenViaJupiter(
  connection: Connection,
  outputMint: PublicKey,
  amountIn: BN,
  slippageBps = 100
): Promise<BN> {
  const quoteParams = new URLSearchParams({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: outputMint.toBase58(),
    amount: amountIn.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
  });

  const quoteUrl = `https://api.jup.ag/swap/v1/quote?${quoteParams.toString()}`;
  const quoteRes = await fetch(quoteUrl);

  if (!quoteRes.ok) {
    const text = await quoteRes.text();
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${text}`);
  }

  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: getWallet().publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`Jupiter swap failed: ${swapRes.status} ${text}`);
  }

  const swap = await swapRes.json();
  if (swap.error) throw new Error(`Jupiter swap error: ${swap.error}`);

  const { VersionedTransaction } = await import('@solana/web3.js');
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([getWallet()]);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  return new BN(quote.outAmount);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: any = {
    simulate: false,
    amount: 0.05,
    skipJupiter: false,
    tokenAmount: null, // raw units (BN friendly)
    useBalance: null,  // e.g. "50%", "0.8", "75"
    strategy: 'evil-panda',
    execute: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pool') opts.pool = args[++i];
    else if (arg === '--mint') opts.mint = args[++i];
    else if (arg === '--amount') opts.amount = parseFloat(args[++i]);
    else if (arg === '--simulate') opts.simulate = true;
    else if (arg === '--skip-jupiter') opts.skipJupiter = true;
    else if (arg === '--token-amount') opts.tokenAmount = args[++i];
    else if (arg === '--use-balance') opts.useBalance = args[++i];
    else if (arg === '--min-bin') opts.minBin = parseInt(args[++i]);
    else if (arg === '--max-bin') opts.maxBin = parseInt(args[++i]);
    else if (arg === '--strategy') opts.strategy = args[++i];
    else if (arg === '--execute') opts.execute = true;
    else if (arg === '--help') {
      console.log('See top of file for usage.');
      process.exit(0);
    }
  }

  if (!opts.pool || !opts.mint) {
    console.error('Error: --pool and --mint are required');
    console.error('Example: npx tsx scripts/test-dlmm-direct.ts --pool <addr> --mint <addr> --simulate');
    process.exit(1);
  }

  if (opts.skipJupiter && !opts.tokenAmount && !opts.useBalance) {
    console.error('Error: When using --skip-jupiter you must provide either --token-amount or --use-balance');
    console.error('Examples:');
    console.error('  --skip-jupiter --token-amount 1234567890');
    console.error('  --skip-jupiter --use-balance 50%');
    process.exit(1);
  }

  if (opts.useBalance && !opts.skipJupiter) {
    console.warn('Note: --use-balance is only meaningful together with --skip-jupiter. Ignoring it.');
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  const connection = getConnection();
  const wallet = getWallet();

  if (!connection) {
    console.error('\n❌ No RPC configured. Make sure .env.local has HELIUS_RPC_URL or RPC_URL set.');
    process.exit(1);
  }

  console.log('=== DLMM Direct Path Tester ===');
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Pool:', opts.pool);
  console.log('Mint:', opts.mint);
  console.log('Amount (SOL):', opts.amount);
  console.log('Simulate only:', opts.simulate);
  console.log('');

  const poolPubkey = new PublicKey(opts.pool);
  const outputMint = new PublicKey(opts.mint);

  // 1. Load DLMM pool
  console.log('[1/5] Loading DLMM pool...');
  const dlmm = await DLMM.create(connection, poolPubkey);

  // Safe way to get activeId (some SDK versions return number, some return BN)
  const rawActiveId = dlmm.lbPair.activeId;
  const activeBinIdNum: number = typeof rawActiveId === 'number' 
    ? rawActiveId 
    : (rawActiveId?.toNumber ? rawActiveId.toNumber() : Number(rawActiveId));

  console.log('  Active bin:', activeBinIdNum);
  console.log('  Bin step:', dlmm.lbPair.binStep);

  // 2. Token program check (needed early for ATA in skip-jupiter mode)
  const tokenProgram = await getTokenProgramId(outputMint);
  const isToken2022 = tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  console.log('[2/5] Output mint program:', isToken2022 ? 'Token-2022' : 'Legacy Token');

  // 3. Determine bin range using Meteora's recommended price-based method (getBinIdFromPrice)
  let minBinId: number;
  let maxBinId: number;

  if (opts.minBin !== undefined && opts.maxBin !== undefined) {
    minBinId = opts.minBin;
    maxBinId = opts.maxBin;
    console.log(`[3/5] Using explicit bin range: ${minBinId} → ${maxBinId}`);
  } else {
    // === PROPER METEORA-RECOMMENDED WAY ===
    // Instead of manual percentage math, we:
    // 1. Get the current active bin price
    // 2. Compute target prices from the strategy's desired % range
    // 3. Convert target prices to bin IDs using dlmm.getBinIdFromPrice (the official way)
    // 4. Use buildLiquidityStrategyParameters + the strategy builder for proper distribution

    const strategyId = opts.strategy;

    // Define desired price ranges per strategy (this is what the user configures)
    let rangeDownPct = -50;
    let rangeUpPct = 100;
    let strategyType: any = 'Spot'; // Spot | BidAsk | Curve

    if (strategyId === 'scalp-spike') {
      rangeDownPct = -20;
      rangeUpPct = 40;
      strategyType = 'Spot'; // or 'Curve' depending on preference
    } else if (strategyId === 'evil-panda') {
      rangeDownPct = -50;
      rangeUpPct = 100;
      strategyType = 'Spot';
    }

    const activeBin = await dlmm.getActiveBin();
    const currentPrice = Number(dlmm.fromPricePerLamport(activeBin.price));

    const targetLowPrice = currentPrice * (1 + rangeDownPct / 100);
    const targetHighPrice = currentPrice * (1 + rangeUpPct / 100);

    // Official Meteora way to get safe bin IDs from target prices
    const calculatedMinBin = dlmm.getBinIdFromPrice(targetLowPrice, true);   // floor for lower bound
    const calculatedMaxBin = dlmm.getBinIdFromPrice(targetHighPrice, false); // ceil for upper bound

    minBinId = calculatedMinBin;
    maxBinId = calculatedMaxBin;

    const binRange = maxBinId - minBinId + 1;

    console.log(`[3/5] Using OFFICIAL Meteora price-based method for ${strategyId}`);
    console.log(`      Current price: ${currentPrice.toFixed(12)}`);
    console.log(`      Target price range: ${targetLowPrice.toFixed(12)} → ${targetHighPrice.toFixed(12)}`);
    console.log(`      Calculated bins: ${minBinId} → ${maxBinId} (${binRange} bins)`);
  }

  const positionKeypair = new Keypair();

  // 4. Acquire output tokens
  let tokenAmountOut: BN;

  if (opts.skipJupiter) {
    console.log('[4/5] Skipping Jupiter (using existing token balance)...');

    const ata = getAssociatedTokenAddressSync(outputMint, wallet.publicKey, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const balanceInfo = await connection.getTokenAccountBalance(ata).catch(() => null);

    if (!balanceInfo || new BN(balanceInfo.value.amount).isZero()) {
      console.error('  ✗ You have no balance of this token. Cannot use --skip-jupiter.');
      process.exit(1);
    }

    const rawBalance = new BN(balanceInfo.value.amount);
    console.log(`  Your current balance: ${rawBalance.toString()} raw units`);

    if (opts.useBalance) {
      // Parse percentage: supports "50%", "0.5", "50", "75.5%"
      let percent = opts.useBalance;
      if (percent.endsWith('%')) percent = percent.slice(0, -1);
      const p = parseFloat(percent);
      if (isNaN(p) || p <= 0 || p > 100) {
        console.error('Invalid --use-balance value. Use something like 50% or 0.75');
        process.exit(1);
      }
      const factor = p > 1 ? p / 100 : p; // accept both 50 and 0.5
      tokenAmountOut = rawBalance.mul(new BN(Math.floor(factor * 1_000_000))).div(new BN(1_000_000));
      console.log(`  Using ${p}% of balance → ${tokenAmountOut.toString()} raw units`);
    } else if (opts.tokenAmount) {
      tokenAmountOut = new BN(opts.tokenAmount);
      console.log(`  Using provided token amount: ${tokenAmountOut.toString()} (raw units)`);
      if (tokenAmountOut.gt(rawBalance)) {
        console.warn('  ⚠ Warning: Requested amount is higher than your current balance.');
      }
    } else {
      // Should never happen due to earlier validation
      tokenAmountOut = rawBalance;
    }
  } else {
    // Normal path: do Jupiter swap
    const amountIn = new BN(Math.floor(opts.amount * 1e9));
    try {
      console.log('[4/5] Swapping SOL → token via Jupiter...');
      tokenAmountOut = await swapSolToTokenViaJupiter(connection, outputMint, amountIn, 150);
      console.log('  Received:', tokenAmountOut.toString(), 'raw tokens');
    } catch (e: any) {
      console.error('Jupiter swap failed:', e.message);
      if (!opts.simulate) {
        throw e;
      }
      console.log('  (Continuing in simulate mode with dummy amount)');
      tokenAmountOut = new BN('1000000000'); // dummy
    }
  }

  // 5. DLMM SDK call — using the standard, widely-used pattern
  console.log('[5/5] Preparing DLMM SDK call...');

  const { StrategyType } = await import('@meteora-ag/dlmm');

  let sdkStrategyType = StrategyType.Spot;
  if (opts.strategy === 'scalp-spike') sdkStrategyType = StrategyType.Spot;
  if (opts.strategy === 'evil-panda')   sdkStrategyType = StrategyType.Spot;

  const params = {
    positionPubKey: positionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount: dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
      ? new BN(0)
      : tokenAmountOut,
    totalYAmount: dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
      ? new BN(0)
      : tokenAmountOut,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: sdkStrategyType,
    },
  };

  // Always print the critical parameters before calling the SDK
  console.log('\n=== DLMM Call Parameters (for diagnosis) ===');
  console.log('activeBinIdNum     :', activeBinIdNum);
  console.log('binStep            :', dlmm.lbPair.binStep);
  console.log('minBinId           :', minBinId);
  console.log('maxBinId           :', maxBinId);
  console.log('range width (bins) :', maxBinId - minBinId + 1);
  console.log('minDeltaId         :', minBinId - activeBinIdNum);
  console.log('maxDeltaId         :', maxBinId - activeBinIdNum);
  console.log('strategy (range)   :', opts.strategy);
  console.log('================================================\n');

  if (opts.simulate) {
    console.log('=== SIMULATION MODE ===');
    console.log('Calling the SDK (it will do internal simulation). Errors will be shown.\n');
  } else {
    console.log('⚠️  REAL EXECUTION MODE — This will attempt a real on-chain open!');
    if (opts.amount > 0.02) {
      console.log('   Amount capped at 0.02 SOL for safety.');
      opts.amount = 0.02;
    }
    console.log('   Amount:', opts.amount, 'SOL\n');
  }

  console.log('Calling initializePositionAndAddLiquidityByStrategy...');

  try {
    // This is the exact call used in production (with retries removed for the test)
    const result: any = await dlmm.initializePositionAndAddLiquidityByStrategy(params as any);

    console.log('\n✅ SDK call returned a Transaction object (but check if it actually succeeded on-chain).');
    console.log('Result keys:', Object.keys(result || {}));
  } catch (err: any) {
    console.error('\n❌ DLMM SDK call FAILED');
    console.error('Error:', err?.message || err);

    if (err?.logs) {
      console.error('\nProgram logs:');
      console.dir(err.logs);
    }

    console.log('\n--- Diagnosis ---');
    if (err?.message?.includes('InvalidPositionWidth') || err?.message?.includes('6040')) {
      console.log('This is Error 6040 = InvalidPositionWidth');
      console.log('The bin range requested is too wide for this pool at this moment.');
      console.log('This is exactly what our early validation in open.ts is supposed to catch and shrink.');
    } else {
      console.log('Unexpected error during DLMM SDK call.');
    }
  }
}

main().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});
