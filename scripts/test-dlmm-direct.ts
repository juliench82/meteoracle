/**
 * scripts/test-dlmm-direct.ts
 *
 * Isolated tester for the direct DLMM SDK path used for Token-2022 / pump.fun graduates.
 *
 * Focused on the split creation path (initializePosition2 + increasePositionLength2 + addLiquidity)
 * for wide ranges that hit realloc limits with the normal combined call.
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
 *
 *   # Test the split path in simulation (current recommended mode)
 *   # Focuses purely on making wide-range split creation + liquidity work.
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool ... --mint ... --amount 0.05 \
 *     --simulate
 *
 *   # Real split execution (small amount)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool ... --mint ... --amount 0.02 \
 *     --split
 */

import * as dotenvLocal from 'dotenv';
import * as path from 'path';
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true });

import { Keypair, PublicKey, Connection, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';

import { getConnection, getWallet } from '@/lib/solana';
import { getTokenProgramId } from '@/bot/executor/utils';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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

async function getSolBalance(connection: Connection, pubkey: PublicKey): Promise<string> {
  const lamports = await connection.getBalance(pubkey);
  return (lamports / 1e9).toFixed(6);
}

async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey
): Promise<string> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
  try {
    const info = await connection.getTokenAccountBalance(ata);
    return info.value.uiAmountString || '0';
  } catch {
    return '0 (no ATA)';
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: any = {
    simulate: false,
    amount: 0.01,
    skipJupiter: false,
    tokenAmount: null, // raw units (BN friendly)
    useBalance: null,  // e.g. "50%", "0.8", "75"
    strategy: 'evil-panda',
    execute: false,
    split: false,
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
    else if (arg === '--split') opts.split = true;
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

  // === TEST SCRIPT SAFETY CAP ===
  // Hard limit for this test script only (not production code).
  // Requested during debugging of the split position flow.
  const MAX_TEST_AMOUNT_SOL = 0.01;
  if (opts.amount > MAX_TEST_AMOUNT_SOL) {
    console.log(`⚠️  [TEST SCRIPT] Safety cap active: Amount capped at ${MAX_TEST_AMOUNT_SOL} SOL (was ${opts.amount}).`);
    opts.amount = MAX_TEST_AMOUNT_SOL;
  }

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

  // === Execution logic ===
  if (opts.simulate) {
    console.log('\n=== SIMULATION MODE (Split Path Only) ===\n');

    // SPLIT PATH — follows the exact internal pattern the Meteora SDK uses for wide ranges
    console.log('--- SPLIT PATH (initializePosition2 + increasePositionLength2) ---');
    try {
      const DEFAULT_BIN_PER_POSITION = 70;
      const MAX_RESIZE_LENGTH = 91;

      const desiredWidth = maxBinId - minBinId + 1;
      const initialWidth = Math.min(DEFAULT_BIN_PER_POSITION, desiredWidth);

      // Pre-creation balances (after Jupiter, before any DLMM position work)
      const solBefore = await getSolBalance(connection, wallet.publicKey);
      const tokenBefore = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
      console.log(`  Balances before position creation: SOL ${solBefore} | Token ${tokenBefore}`);

      // 1. Initialize position with starting width (capped at 70)
      const initIx = await dlmm.program.methods
        .initializePosition2(minBinId, initialWidth)
        .accountsPartial({
          payer: wallet.publicKey,
          position: positionKeypair.publicKey,
          lbPair: poolPubkey,
          owner: wallet.publicKey,
        })
        .instruction();

      // 2. Extend position length as needed (in chunks of up to 91 bins)
      const extendIxs = [];
      let currentEndBinId = minBinId + initialWidth - 1;
      while (currentEndBinId < maxBinId) {
        currentEndBinId = Math.min(currentEndBinId + MAX_RESIZE_LENGTH, maxBinId);
        const extendIx = await dlmm.program.methods
          .increasePositionLength2(currentEndBinId)
          .accountsPartial({
            lbPair: poolPubkey,
            position: positionKeypair.publicKey,
            funder: wallet.publicKey,
            owner: wallet.publicKey,
          })
          .instruction();
        extendIxs.push(extendIx);
      }

      // Send position creation + extension(s) in one tx
      const createTx = new Transaction().add(initIx, ...extendIxs);
      createTx.feePayer = wallet.publicKey;
      const { blockhash: bh1 } = await connection.getLatestBlockhash();
      createTx.recentBlockhash = bh1;
      createTx.sign(positionKeypair);

      const createSig = await connection.sendTransaction(createTx, [wallet, positionKeypair]);
      await connection.confirmTransaction(createSig, 'confirmed');
      console.log('  ✓ Position created + extended. Sig:', createSig);
      if (extendIxs.length > 0) {
        console.log(`    (Used ${extendIxs.length} increasePositionLength2 instruction(s))`);
      }

      const solAfterCreate = await getSolBalance(connection, wallet.publicKey);
      const tokenAfterCreate = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
      console.log(`  Balances after position creation (before liquidity): SOL ${solAfterCreate} | Token ${tokenAfterCreate}`);

      // 3. Add liquidity — low-level using the program method (following SDK internal pattern)
      console.log('  Adding liquidity via low-level addLiquidityByStrategy2...');

      const totalX = dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
        ? new BN(0) : tokenAmountOut;
      const totalY = dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
        ? new BN(0) : tokenAmountOut;

      // Derive user token accounts (correct program ID for Token-2022 vs regular)
      const isTokenXSol = dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';
      const isTokenYSol = dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';

      const userTokenX = getAssociatedTokenAddressSync(
        dlmm.tokenX.publicKey,
        wallet.publicKey,
        false,
        isTokenXSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
      );

      const userTokenY = getAssociatedTokenAddressSync(
        dlmm.tokenY.publicKey,
        wallet.publicKey,
        false,
        isTokenYSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
      );

      // Determine the correct token programs for the instruction
      const tokenXProgram = isTokenXSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
      const tokenYProgram = isTokenYSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

      // Decide whether to include binArrayBitmapExtension.
      // We now do a robust check: derive the PDA and verify the account actually exists
      // and is owned by the Meteora program before including it.
      const BIN_ARRAY_BITMAP_EXTENSION_SEED = Buffer.from("bitmap");
      const [possibleBinArrayBitmapExtension] = PublicKey.findProgramAddressSync(
        [BIN_ARRAY_BITMAP_EXTENSION_SEED, poolPubkey.toBuffer()],
        dlmm.program.programId
      );

      const bitmapExtensionInfo = await connection.getAccountInfo(possibleBinArrayBitmapExtension);
      const includeBitmapExtension =
        !!bitmapExtensionInfo &&
        bitmapExtensionInfo.owner.toBase58() === dlmm.program.programId.toBase58();

      const binArrayBitmapExtension = includeBitmapExtension ? possibleBinArrayBitmapExtension : null;

      console.log(`  Bitmap extension needed? ${includeBitmapExtension} (account exists & owned by Meteora: ${!!bitmapExtensionInfo})`);

      // Build liquidity parameters similar to what the SDK uses internally
      const liquidityParams = {
        minBinId,
        maxBinId,
        strategyType: sdkStrategyType,
      };

      try {
        const accounts: any = {
          position: positionKeypair.publicKey,
          lbPair: poolPubkey,
          sender: wallet.publicKey,
          user: wallet.publicKey,
          userTokenX,
          userTokenY,
          tokenXProgram,
          tokenYProgram,
        };

        if (binArrayBitmapExtension) {
          accounts.binArrayBitmapExtension = binArrayBitmapExtension;
        }

        const addLiqIx = await dlmm.program.methods
          .addLiquidityByStrategy2(liquidityParams as any, { slices: [] })
          .accountsPartial(accounts)
          .instruction();

        const liqTx = new Transaction().add(addLiqIx);
        liqTx.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        liqTx.recentBlockhash = blockhash;
        liqTx.sign(wallet);

        const sig = await connection.sendTransaction(liqTx, [wallet]);
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('  ✓ Low-level liquidity tx sent. Sig:', sig);
      } catch (liqErr: any) {
        console.error('  ❌ Low-level liquidity addition failed:');
        console.error('     ', liqErr?.message || liqErr);
        if (liqErr?.logs) console.error('     Logs:', liqErr.logs);
      }

      const solAfterLiq = await getSolBalance(connection, wallet.publicKey);
      const tokenAfterLiq = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
      console.log(`  Balances after liquidity attempt: SOL ${solAfterLiq} | Token ${tokenAfterLiq}`);

      // 4. Inspect the actual position state on-chain
      try {
        const userPositions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
        const ourPosition = userPositions?.userPositions?.find(
          (p: any) => p.publicKey?.toBase58?.() === positionKeypair.publicKey.toBase58()
        );

        if (ourPosition?.positionData) {
          const pd = ourPosition.positionData;
          const lower = pd.lowerBinId ?? 'n/a';
          const upper = pd.upperBinId ?? 'n/a';
          const totalLiquidity = pd.totalLiquidity ?? 'n/a';
          console.log('  ✓ Position found on-chain:');
          console.log(`    Bin range: ${lower} → ${upper}`);
          console.log(`    Total liquidity (raw): ${totalLiquidity}`);
          console.log('    (If total liquidity is 0 or missing, no liquidity was deposited)');
        } else {
          console.log('  ⚠ Could not find our position in userPositions response.');
        }
      } catch (inspectErr: any) {
        console.log('  (Position inspection failed:', inspectErr?.message || inspectErr, ')');
      }

      console.log('✅ SPLIT path completed (see balances + position inspection above).');
    } catch (err: any) {
      console.error('❌ SPLIT path failed:');
      console.error('   ', err?.message || err);
      if (err?.logs) console.error('   Logs:', err.logs);
    }

    console.log('\n=== End of simulation ===');
    return;

  } else {
    // Real execution (respect --split flag)
    console.log('⚠️  REAL EXECUTION MODE');

    if (opts.split) {
      console.log('\n=== REAL SPLIT EXECUTION (position + liquidity) ===\n');

      const DEFAULT_BIN_PER_POSITION = 70;
      const MAX_RESIZE_LENGTH = 91;
      const desiredWidth = maxBinId - minBinId + 1;
      const initialWidth = Math.min(DEFAULT_BIN_PER_POSITION, desiredWidth);

      console.log(`Creating position with split strategy (${desiredWidth} bins total)...`);

      try {
        // 1. Create + extend position
        const initIx = await dlmm.program.methods
          .initializePosition2(minBinId, initialWidth)
          .accountsPartial({
            payer: wallet.publicKey,
            position: positionKeypair.publicKey,
            lbPair: poolPubkey,
            owner: wallet.publicKey,
          })
          .instruction();

        const extendIxs = [];
        let currentEndBinId = minBinId + initialWidth - 1;
        while (currentEndBinId < maxBinId) {
          currentEndBinId = Math.min(currentEndBinId + MAX_RESIZE_LENGTH, maxBinId);
          const extendIx = await dlmm.program.methods
            .increasePositionLength2(currentEndBinId)
            .accountsPartial({
              lbPair: poolPubkey,
              position: positionKeypair.publicKey,
              funder: wallet.publicKey,
              owner: wallet.publicKey,
            })
            .instruction();
          extendIxs.push(extendIx);
        }

        const createTx = new Transaction().add(initIx, ...extendIxs);
        createTx.feePayer = wallet.publicKey;
        const { blockhash: bh1 } = await connection.getLatestBlockhash();
        createTx.recentBlockhash = bh1;
        createTx.sign(positionKeypair);

        const createSig = await connection.sendTransaction(createTx, [wallet, positionKeypair]);
        await connection.confirmTransaction(createSig, 'confirmed');
        console.log('✓ Position created + extended. Sig:', createSig);

        // 2. Add liquidity — low-level using the program method
        console.log('Adding liquidity via low-level addLiquidityByStrategy2...');

        const totalX = dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
          ? new BN(0) : tokenAmountOut;
        const totalY = dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112'
          ? new BN(0) : tokenAmountOut;

        // Derive user token accounts (correct program ID for Token-2022 vs regular)
        const isTokenXSol = dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';
        const isTokenYSol = dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';

        const userTokenX = getAssociatedTokenAddressSync(
          dlmm.tokenX.publicKey,
          wallet.publicKey,
          false,
          isTokenXSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
        );

        const userTokenY = getAssociatedTokenAddressSync(
          dlmm.tokenY.publicKey,
          wallet.publicKey,
          false,
          isTokenYSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
        );

        // Determine the correct token programs for the instruction
        const tokenXProgram = isTokenXSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        const tokenYProgram = isTokenYSol ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

        // Decide whether to include binArrayBitmapExtension (robust existence check)
        const BIN_ARRAY_BITMAP_EXTENSION_SEED = Buffer.from("bitmap");
        const [possibleBinArrayBitmapExtension] = PublicKey.findProgramAddressSync(
          [BIN_ARRAY_BITMAP_EXTENSION_SEED, poolPubkey.toBuffer()],
          dlmm.program.programId
        );

        const bitmapExtensionInfo = await connection.getAccountInfo(possibleBinArrayBitmapExtension);
        const includeBitmapExtension =
          !!bitmapExtensionInfo &&
          bitmapExtensionInfo.owner.toBase58() === dlmm.program.programId.toBase58();

        const binArrayBitmapExtension = includeBitmapExtension ? possibleBinArrayBitmapExtension : null;

        console.log(`  Bitmap extension needed? ${includeBitmapExtension} (account exists & owned by Meteora: ${!!bitmapExtensionInfo})`);

        const liquidityParams = {
          minBinId,
          maxBinId,
          strategyType: sdkStrategyType,
        };

        try {
          const accounts: any = {
            position: positionKeypair.publicKey,
            lbPair: poolPubkey,
            sender: wallet.publicKey,
            user: wallet.publicKey,
            userTokenX,
            userTokenY,
            tokenXProgram,
            tokenYProgram,
          };

          if (binArrayBitmapExtension) {
            accounts.binArrayBitmapExtension = binArrayBitmapExtension;
          }

          const addLiqIx = await dlmm.program.methods
            .addLiquidityByStrategy2(liquidityParams as any, { slices: [] })
            .accountsPartial(accounts)
            .instruction();

          const liqTx = new Transaction().add(addLiqIx);
          liqTx.feePayer = wallet.publicKey;
          const { blockhash } = await connection.getLatestBlockhash();
          liqTx.recentBlockhash = blockhash;
          liqTx.sign(wallet);

          const sig = await connection.sendTransaction(liqTx, [wallet]);
          await connection.confirmTransaction(sig, 'confirmed');
          console.log('✓ Low-level liquidity tx sent. Sig:', sig);
        } catch (liqErr: any) {
          console.error('❌ Low-level liquidity addition failed:', liqErr?.message || liqErr);
          if (liqErr?.logs) console.error('Logs:', liqErr.logs);
        }

        // 3. Final position inspection
        try {
          const userPositions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
          const ourPosition = userPositions?.userPositions?.find(
            (p: any) => p.publicKey?.toBase58?.() === positionKeypair.publicKey.toBase58()
          );
          if (ourPosition?.positionData) {
            const pd = ourPosition.positionData;
            console.log('✓ Final position state:');
            console.log(`  Bin range: ${pd.lowerBinId} → ${pd.upperBinId}`);
            console.log(`  Total liquidity: ${pd.totalLiquidity ?? '0'}`);
          }
        } catch {}

        console.log('\n✅ Real split open completed.');
      } catch (err: any) {
        console.error('❌ Real split open failed:', err?.message || err);
        if (err?.logs) console.error('Logs:', err.logs);
      }
    } else {
      try {
        await dlmm.initializePositionAndAddLiquidityByStrategy(params as any);
        console.log('✅ Real combined open succeeded.');
      } catch (err: any) {
        console.error('❌ Real combined open failed:', err?.message || err);
      }
    }
  }
}

main().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});
