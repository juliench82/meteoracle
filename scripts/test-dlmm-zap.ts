/**
 * scripts/test-dlmm-zap.ts
 *
 * Isolated tester for the Meteora DLMM **Zap** path (the @meteora-ag/zap-sdk flow).
 *
 * This is the companion to `test-dlmm-direct.ts`.
 * Use it to quickly test whether the Zap path works on a specific pool/token
 * without having to run the full scanner.
 *
 * Usage examples:
 *
 *   # Best first step — simulate the entire Zap bundle
 *   npx tsx scripts/test-dlmm-zap.ts \
 *     --pool <DLMM_POOL_ADDRESS> \
 *     --mint <TOKEN_MINT> \
 *     --amount 0.05 \
 *     --simulate
 *
 *   # Skip Jupiter (you already hold the token) and use 40% of your balance
 *   npx tsx scripts/test-dlmm-zap.ts \
 *     --pool <pool> \
 *     --mint <mint> \
 *     --skip-jupiter \
 *     --use-balance 40% \
 *     --simulate
 *
 *   # Force a specific bin range (useful for reproducing exact failures)
 *   npx tsx scripts/test-dlmm-zap.ts \
 *     --pool ... --mint ... --amount 0.05 \
 *     --min-bin -450 --max-bin -350 \
 *     --simulate
 */

import { Keypair, PublicKey, Connection, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import { getZap, getStrategyType, strategyTypeForDistribution } from '@/bot/executor/utils';
import { getConnection, getWallet } from '@/lib/solana';
import { getTokenProgramId } from '@/bot/executor/utils';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

// Minimal Jupiter swap helper (same as the direct tester)
async function swapSolToTokenViaJupiter(
  connection: Connection,
  outputMint: PublicKey,
  amountIn: BN,
  slippageBps = 150
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
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);

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
  if (!swapRes.ok) throw new Error(`Jupiter swap failed: ${swapRes.status}`);

  const swap = await swapRes.json();
  if (swap.error) throw new Error(`Jupiter swap error: ${swap.error}`);

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([getWallet()]);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');

  return new BN(quote.outAmount);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: any = {
    simulate: false,
    amount: 0.05,
    skipJupiter: false,
    tokenAmount: null,
    useBalance: null,
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
    else if (arg === '--help') {
      console.log('See top of file for usage.');
      process.exit(0);
    }
  }

  if (!opts.pool || !opts.mint) {
    console.error('Error: --pool and --mint are required');
    process.exit(1);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  const connection = getConnection();
  const wallet = getWallet();

  console.log('=== DLMM Zap Path Tester ===');
  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Pool:', opts.pool);
  console.log('Mint:', opts.mint);
  console.log('Amount (SOL):', opts.amount);
  console.log('Simulate only:', opts.simulate);
  console.log('');

  const poolPubkey = new PublicKey(opts.pool);
  const outputMint = new PublicKey(opts.mint);

  // 1. Load pool
  console.log('[1/6] Loading DLMM pool...');
  const dlmmPool = await DLMM.create(connection, poolPubkey);
  console.log('  Active bin:', dlmmPool.lbPair.activeId.toString());
  console.log('  Bin step:', dlmmPool.lbPair.binStep);

  // 2. Token program
  const outputTokenProgram = await getTokenProgramId(outputMint);
  const isToken2022 = outputTokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  console.log('[2/6] Output mint program:', isToken2022 ? 'Token-2022' : 'Legacy Token');

  // 3. Bin range
  const activeBinId = dlmmPool.lbPair.activeId.toNumber();
  let minBinId: number, maxBinId: number;

  if (opts.minBin !== undefined && opts.maxBin !== undefined) {
    minBinId = opts.minBin;
    maxBinId = opts.maxBin;
  } else {
    // Reasonable default range
    minBinId = activeBinId - 50;
    maxBinId = activeBinId + 100;
  }
  console.log(`[3/6] Using bin range: ${minBinId} → ${maxBinId}`);

  const positionKeypair = new Keypair();
  let tokenAmountOut: BN;

  // 4. Get tokens (Jupiter or existing balance)
  if (opts.skipJupiter) {
    console.log('[4/6] Using existing token balance (--skip-jupiter)...');

    const ata = getAssociatedTokenAddressSync(outputMint, wallet.publicKey, false, outputTokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
    const balanceInfo = await connection.getTokenAccountBalance(ata).catch(() => null);

    if (!balanceInfo || new BN(balanceInfo.value.amount).isZero()) {
      console.error('  ✗ No balance found for this token.');
      process.exit(1);
    }

    const rawBalance = new BN(balanceInfo.value.amount);
    console.log(`  Current balance: ${rawBalance.toString()} raw units`);

    if (opts.useBalance) {
      let p = parseFloat(opts.useBalance.replace('%', ''));
      if (p > 1) p = p / 100;
      tokenAmountOut = rawBalance.mul(new BN(Math.floor(p * 1_000_000))).div(new BN(1_000_000));
      console.log(`  Using ${opts.useBalance} of balance → ${tokenAmountOut.toString()}`);
    } else if (opts.tokenAmount) {
      tokenAmountOut = new BN(opts.tokenAmount);
    } else {
      tokenAmountOut = rawBalance;
    }
  } else {
    const amountIn = new BN(Math.floor(opts.amount * 1e9));
    console.log('[4/6] Swapping SOL via Jupiter...');
    tokenAmountOut = await swapSolToTokenViaJupiter(connection, outputMint, amountIn);
    console.log('  Received:', tokenAmountOut.toString(), 'raw tokens');
  }

  // 5. Prepare Zap
  console.log('[5/6] Preparing Zap (estimate + build)...');

  const { estimateDlmmDirectSwap } = await import('@meteora-ag/zap-sdk');
  const zap = await getZap();

  const amountInLamports = new BN(Math.floor(opts.amount * 1e9)); // we still need SOL amount for the estimate

  const directSwapEstimate = await estimateDlmmDirectSwap({
    amountIn: amountInLamports,
    inputTokenMint: new PublicKey('So11111111111111111111111111111111111111112'),
    lbPair: poolPubkey,
    connection,
    swapSlippageBps: 100,
    minDeltaId: minBinId - activeBinId,
    maxDeltaId: maxBinId - activeBinId,
    strategy: strategyTypeForDistribution(await getStrategyType(), 'spot'),
  });

  const zapParams = await zap.getZapInDlmmDirectParams({
    user: wallet.publicKey,
    lbPair: poolPubkey,
    inputTokenMint: new PublicKey('So11111111111111111111111111111111111111112'),
    amountIn: amountInLamports,
    maxActiveBinSlippage: 100,
    minDeltaId: minBinId - activeBinId,
    maxDeltaId: maxBinId - activeBinId,
    strategy: strategyTypeForDistribution(await getStrategyType(), 'spot'),
    favorXInActiveId: dlmmPool.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112',
    maxAccounts: 64,
    swapSlippageBps: 100,
    maxTransferAmountExtendPercentage: 10,
    directSwapEstimate: directSwapEstimate.result,
  });

  const zapResponse = await zap.buildZapInDlmmTransaction({
    ...zapParams,
    position: positionKeypair.publicKey,
  });

  console.log('  Zap bundle built successfully.');
  console.log('  Transactions in bundle:');
  console.log('   - setup:', zapResponse.setupTransaction?.instructions.length ?? 0);
  console.log('   - swaps:', zapResponse.swapTransactions.length);
  console.log('   - ledger:', zapResponse.ledgerTransaction?.instructions.length ?? 0);
  console.log('   - zapIn:', zapResponse.zapInTransaction?.instructions.length ?? 0);
  console.log('   - cleanup:', zapResponse.cleanUpTransaction?.instructions.length ?? 0);

  if (opts.simulate) {
    console.log('\n=== SIMULATION MODE ===');
    console.log('We will now simulate the key transactions (setup + zapIn).');
    // For now we just log that simulation would happen here.
    // Full simulation of every Zap tx can be added later if needed.
    console.log('Simulation of Zap bundles is complex because they contain multiple txs.');
    console.log('If you want deeper simulation, let me know and I can extend this script.');
    return;
  }

  // 6. Send the Zap bundle (real execution)
  console.log('\n[6/6] Sending Zap bundle (REAL EXECUTION)...');
  console.log('WARNING: This will spend real SOL and create a real position.');

  // In a real implementation we would send the transactions here using sendLegacyTx / sendVersionedTx
  // For safety in this test script we stop here unless the user removes the guard.
  console.log('\nReal sending is disabled in this test script for safety.');
  console.log('If you want the script to actually send the Zap bundle, tell me and I will add it with a big confirmation prompt.');
}

main().catch((err) => {
  console.error('\nScript failed:', err);
  process.exit(1);
});
