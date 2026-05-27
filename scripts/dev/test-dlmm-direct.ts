/**
 * scripts/dev/test-dlmm-direct.ts
 *
 * IMPORTANT HISTORICAL TEST SCRIPT
 * ---------------------------------
 * This script was the primary validation tool used to prove the low-level DLMM split path
 * for wide-range evil-panda positions on fresh Token-2022 / pump.fun graduates.
 *
 * Key things proven here before porting to production (bot/executor/open.ts):
 *   - initializePosition2 + increasePositionLength2 + addLiquidityByStrategy2
 *   - 1.4M CU limit instead of the default 600k (critical for ~150 bin ranges)
 *   - Separate ATA creation transaction before the expensive liquidity tx
 *   - Proactive bin array initialization to avoid AccountOwnedByWrongProgram (3007)
 *   - Dynamic bin range calculation based on actual minBinId / maxBinId (not hardcoded 70/91)
 *
 * This script was run successfully in --simulate mode (and limited live tests) on real
 * fresh evil-panda candidates before the production changes were made.
 *
 * Do not delete — this file serves as evidence that the production low-level path
 * was properly tested in isolation first.
 *
 * ------------------------------------------------------------------------------
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
 *
 *   # Close an empty bin array to recover rent (advanced)
 *   npx tsx scripts/test-dlmm-direct.ts \
 *     --pool <LB_PAIR_ADDRESS> \
 *     --close-bin-array <BIN_ARRAY_ADDRESS>
 *
 *   Safety flags (recommended during testing):
 *     --simulate     → Builds and may send small test transactions
 *     --dry-run      → Builds everything but sends NOTHING
 *     --live         → Required for real sends outside --simulate
 */

import * as dotenvLocal from 'dotenv';
import * as path from 'path';
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true });

import { Keypair, PublicKey, Connection, Transaction, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';

import { getConnection, getWallet } from '@/lib/solana';
import { getTokenProgramId } from '@/bot/executor/utils';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
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
    closeBinArray: null,
    live: false,
    dryRun: false,
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
    else if (arg === '--close-bin-array') opts.closeBinArray = args[++i];
    else if (arg === '--live') opts.live = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help') {
      console.log('See top of file for usage.');
      process.exit(0);
    }
  }

  if (opts.closeBinArray) {
    if (!opts.pool) {
      console.error('Error: --pool is required when using --close-bin-array');
      process.exit(1);
    }
  } else {
    if (!opts.pool || !opts.mint) {
      console.error('Error: --pool and --mint are required');
      console.error('Example: npx tsx scripts/test-dlmm-direct.ts --pool <addr> --mint <addr> --simulate');
      process.exit(1);
    }
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

// ---------------------------------------------------------------------------
// Shared helper: resolve + optionally initialize binArrayBitmapExtension
// Returns the PDA pubkey if it exists (or was just initialized), null if not
// needed (i.e. the range doesn't require it and the account doesn't exist).
// ---------------------------------------------------------------------------
async function resolveBitmapExtension(
  connection: Connection,
  dlmm: any,
  poolPubkey: PublicKey,
  wallet: Keypair,
  dryRun: boolean
): Promise<PublicKey | null> {
  const BIN_ARRAY_BITMAP_EXTENSION_SEED = Buffer.from('bitmap');
  const [pda] = PublicKey.findProgramAddressSync(
    [BIN_ARRAY_BITMAP_EXTENSION_SEED, poolPubkey.toBuffer()],
    dlmm.program.programId
  );

  const info = await connection.getAccountInfo(pda);
  const existsAndOwned =
    !!info && info.owner.toBase58() === dlmm.program.programId.toBase58();

  console.log(
    `  Bitmap extension PDA: ${pda.toBase58()}`,
    existsAndOwned ? '(exists ✓)' : '(does not exist — will initialize)'
  );

  if (existsAndOwned) {
    return pda;
  }

  // Account doesn't exist yet → initialize it
  console.log('  ⚠️  WARNING: Initializing bitmap extension locks ~0.07+ SOL in rent (recoverable on close).');

  if (dryRun) {
    console.log('  [DRY RUN] Would send initializeBinArrayBitmapExtension — skipped.');
    return pda; // return the PDA so downstream code can reference it even in dry-run
  }

  const initIx = await dlmm.program.methods
    .initializeBinArrayBitmapExtension()
    .accountsPartial({
      binArrayBitmapExtension: pda,
      lbPair: poolPubkey,
      funder: wallet.publicKey,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  const initTx = new Transaction().add(initIx);
  initTx.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  initTx.recentBlockhash = blockhash;
  initTx.sign(wallet);

  const sig = await connection.sendTransaction(initTx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('  ✓ binArrayBitmapExtension initialized. Sig:', sig);

  return pda;
}

// ---------------------------------------------------------------------------
// Shared helper: build + send the addLiquidityByStrategy2 raw transaction.
// Used by both --simulate and --split (real) paths so they stay in sync.
// ---------------------------------------------------------------------------
async function sendAddLiquidityByStrategy2(opts: {
  connection: Connection;
  wallet: Keypair;
  dlmm: any;
  poolPubkey: PublicKey;
  positionPubkey: PublicKey;
  minBinId: number;
  maxBinId: number;
  totalX: BN;
  totalY: BN;
  sdkStrategyType: any;
  getBinArrayAccountMetasCoverage: any;
  toStrategyParameters: any;
  binArrayBitmapExtension: PublicKey | null;
  tokenXProgramId: PublicKey;
  tokenYProgramId: PublicKey;
  dryRun: boolean;
}): Promise<void> {
  const {
    connection, wallet, dlmm, poolPubkey, positionPubkey,
    minBinId, maxBinId, totalX, totalY, sdkStrategyType,
    getBinArrayAccountMetasCoverage, toStrategyParameters,
    binArrayBitmapExtension, tokenXProgramId, tokenYProgramId, dryRun,
  } = opts;

  const tokenXProgram = tokenXProgramId;
  const tokenYProgram = tokenYProgramId;

  const userTokenX = getAssociatedTokenAddressSync(
    dlmm.tokenX.publicKey,
    wallet.publicKey,
    false,
    tokenXProgram
  );
  const userTokenY = getAssociatedTokenAddressSync(
    dlmm.tokenY.publicKey,
    wallet.publicKey,
    false,
    tokenYProgram
  );

  // Ensure ATAs exist
  const preInstructions: any[] = [];
  const userTokenXInfo = await connection.getAccountInfo(userTokenX);
  if (!userTokenXInfo) {
    console.log('  Creating missing ATA for token X...');
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, userTokenX, wallet.publicKey,
        dlmm.tokenX.publicKey, tokenXProgram
      )
    );
  }
  const userTokenYInfo = await connection.getAccountInfo(userTokenY);
  if (!userTokenYInfo) {
    console.log('  Creating missing ATA for token Y...');
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey, userTokenY, wallet.publicKey,
        dlmm.tokenY.publicKey, tokenYProgram
      )
    );
  }

  const currentActiveId = dlmm.lbPair.activeId;
  const distanceToMin = Math.abs(currentActiveId - minBinId);
  const distanceToMax = Math.abs(currentActiveId - maxBinId);
  const maxDistanceFromActive = Math.max(distanceToMin, distanceToMax);
  const SAFETY_BUFFER_BINS = 25;
  const maxActiveBinSlippage = maxDistanceFromActive + SAFETY_BUFFER_BINS;

  const strategyParameters = toStrategyParameters({
    minBinId,
    maxBinId,
    strategyType: sdkStrategyType,
    singleSidedX: false,
  });

  const liquidityParams = {
    amountX: totalX,
    amountY: totalY,
    activeId: currentActiveId,
    maxActiveBinSlippage,
    strategyParameters,
  };

  console.log('  maxActiveBinSlippage:', maxActiveBinSlippage, `(distance ${maxDistanceFromActive} + buffer ${SAFETY_BUFFER_BINS})`);

  const binArrayAccountMetas = getBinArrayAccountMetasCoverage(
    new BN(minBinId),
    new BN(maxBinId),
    poolPubkey,
    dlmm.program.programId
  );

  console.log(`  Bin arrays required for range: ${binArrayAccountMetas.length}`);

  // Resolve transfer hook remaining accounts for Token-2022 (if any)
  let hookSlices: any = { slices: [] };
  let hookRemainingAccounts: any[] = [];

  try {
    const hookData = await dlmm.getPotentialToken2022IxDataAndAccounts(0 /* Liquidity */);
    if (hookData) {
      if (hookData.slices) hookSlices = { slices: hookData.slices };
      if (hookData.accounts && hookData.accounts.length > 0) {
        hookRemainingAccounts = hookData.accounts;
        console.log(`  Adding ${hookRemainingAccounts.length} transfer hook remaining account(s)`);
      }
    }
  } catch (e: any) {
    // Many tokens don't have hooks — this is expected and fine
    console.log('  No transfer hook accounts required for this mint (or resolution skipped)');
  }

  const accounts: any = {
    position: positionPubkey,
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

  const allRemaining = [...binArrayAccountMetas, ...hookRemainingAccounts];
  console.log(`  Total remainingAccounts: ${allRemaining.length} (bin arrays + transfer hooks if any)`);

  const addLiqIx = await dlmm.program.methods
    .addLiquidityByStrategy2(liquidityParams, hookSlices)
    .accountsPartial(accounts)
    .remainingAccounts(allRemaining)
    .instruction();

  const allIxs = [...preInstructions, addLiqIx];

  if (dryRun) {
    console.log('  [DRY RUN] addLiquidityByStrategy2 instruction built — not sending.');
    console.log('  Accounts:', Object.keys(accounts).join(', '));
    console.log('  remainingAccounts count:', allRemaining.length);
    if (allRemaining.length > 0) {
      console.log('  Sample remaining accounts:', allRemaining.slice(0, 3).map((a: any) => a.pubkey.toBase58().slice(0, 8) + '...'));
    }
    return;
  }

  // Send ATA creation in its own transaction first (saves CUs for the expensive liquidity call)
  if (preInstructions.length > 0) {
    const ataTx = new Transaction().add(...preInstructions);
    ataTx.feePayer = wallet.publicKey;
    const { blockhash: ataBlockhash } = await connection.getLatestBlockhash();
    ataTx.recentBlockhash = ataBlockhash;
    ataTx.sign(wallet);

    console.log('  Sending ATA creation transaction first...');
    const ataSig = await connection.sendTransaction(ataTx, [wallet]);
    await connection.confirmTransaction(ataSig, 'confirmed');
    console.log('  ✓ Missing ATA(s) created. Sig:', ataSig);
  }

  // Liquidity transaction with high compute unit limit (experimental 1.4M attempt)
  const liqTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(addLiqIx);

  liqTx.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  liqTx.recentBlockhash = blockhash;
  liqTx.sign(wallet);

  console.log('  Sending addLiquidityByStrategy2 with 1.4M CU limit (experimental)...');
  const sig = await connection.sendTransaction(liqTx, [wallet]);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('  ✓ addLiquidityByStrategy2 sent. Sig:', sig);
  console.log('    remainingAccounts passed:', allRemaining.length);
}

async function main() {
  const opts = parseArgs();

  // === TEST SCRIPT SAFETY CAP ===
  const MAX_TEST_AMOUNT_SOL = 0.01;
  if (opts.amount > MAX_TEST_AMOUNT_SOL) {
    console.log(`⚠️  [TEST SCRIPT] Safety cap active: Amount capped at ${MAX_TEST_AMOUNT_SOL} SOL (was ${opts.amount}).`);
    opts.amount = MAX_TEST_AMOUNT_SOL;
  }

  if (opts.closeBinArray) {
    await closeBinArray(opts.pool, opts.closeBinArray);
    return;
  }

  // === STRONG SAFETY GATES FOR TESTING ===
  const isRiskyOperation = !opts.simulate && !opts.dryRun;

  if (opts.dryRun) {
    console.log('🛡️  DRY RUN MODE — No transactions will be sent to the network.');
  }

  if (isRiskyOperation && !opts.live) {
    console.error('\n❌ Refusing to run real (non-simulate) operations without explicit confirmation.');
    console.error('   This script can create accounts and lock rent (e.g. positions, bin arrays).');
    console.error('');
    console.error('   To actually send real transactions, re-run with:');
    console.error('     --live');
    console.error('');
    console.error('   Recommended safe workflow:');
    console.error('     --simulate     (builds and sometimes sends small test txs)');
    console.error('     --dry-run      (builds everything, sends nothing)');
    console.error('     --live         (only when you are deliberately accepting risk)');
    process.exit(1);
  }

  if (isRiskyOperation && opts.live) {
    console.log('\n⚠️  LIVE MODE ENABLED — Real transactions will be sent.');
    console.log('   You have explicitly accepted the risk of creating accounts and locking rent.\n');
  }

  if (!opts.dryRun) {
    console.log('\n=== SAFETY SUMMARY ===');
    console.log(`  Mode: ${opts.simulate ? 'SIMULATE' : opts.live ? 'LIVE (real sends)' : 'UNKNOWN'}`);
    console.log(`  Max test amount: 0.01 SOL (hard cap)`);
    console.log(`  Risk: Position creation + possible bin array initialization can lock 0.10–0.25+ SOL in rent.`);
    console.log('  Use --dry-run for maximum safety during development.');
    console.log('========================\n');
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

  const rawActiveId = dlmm.lbPair.activeId;
  const activeBinIdNum: number = typeof rawActiveId === 'number'
    ? rawActiveId
    : (rawActiveId && typeof (rawActiveId as any).toNumber === 'function' 
        ? (rawActiveId as any).toNumber() 
        : Number(rawActiveId));

  console.log('  Active bin:', activeBinIdNum);
  console.log('  Bin step:', dlmm.lbPair.binStep);

  // 2. Token program check
  const tokenProgram = await getTokenProgramId(outputMint);
  const isToken2022 = tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
  console.log('[2/5] Output mint program:', isToken2022 ? 'Token-2022' : 'Legacy Token');

  // Resolve the actual on-chain program IDs for both pool tokens
  const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
  const resolvedTokenXProgram = dlmm.tokenX.publicKey.equals(WSOL)
    ? TOKEN_PROGRAM_ID
    : await getTokenProgramId(dlmm.tokenX.publicKey);
  const resolvedTokenYProgram = dlmm.tokenY.publicKey.equals(WSOL)
    ? TOKEN_PROGRAM_ID
    : await getTokenProgramId(dlmm.tokenY.publicKey);
  console.log('  Token X program:', resolvedTokenXProgram.toBase58());
  console.log('  Token Y program:', resolvedTokenYProgram.toBase58());

  // 3. Determine bin range
  let minBinId: number;
  let maxBinId: number;

  if (opts.minBin !== undefined && opts.maxBin !== undefined) {
    minBinId = opts.minBin;
    maxBinId = opts.maxBin;
    console.log(`[3/5] Using explicit bin range: ${minBinId} → ${maxBinId}`);
  } else {
    const strategyId = opts.strategy;
    let rangeDownPct = -50;
    let rangeUpPct = 100;
    let sdkStrategyTypeLocal: any = 'Spot';

    if (strategyId === 'scalp-spike') {
      rangeDownPct = -20;
      rangeUpPct = 40;
      sdkStrategyTypeLocal = 'Spot';
    } else if (strategyId === 'evil-panda') {
      rangeDownPct = -50;
      rangeUpPct = 100;
      sdkStrategyTypeLocal = 'Spot';
    }

    const activeBin = await dlmm.getActiveBin();
    const activeBinId = activeBin.binId;
    const binStep = dlmm.lbPair.binStep;

    // Arithmetic method (matches production open.ts)
    // bins = percentage / (binStep in percent)
    const binsDown = Math.abs(Math.round((rangeDownPct / 100) / (binStep / 10000)));
    const binsUp   = Math.round((rangeUpPct   / 100) / (binStep / 10000));

    minBinId = activeBinId - binsDown;
    maxBinId = activeBinId + binsUp;

    const binRange = maxBinId - minBinId + 1;

    console.log(`[3/5] Using arithmetic bin-delta method (matches production) for ${strategyId}`);
    console.log(`      Active bin: ${activeBinId}`);
    console.log(`      Bin step: ${binStep}`);
    console.log(`      Range: ${rangeDownPct}% / +${rangeUpPct}%`);
    console.log(`      Calculated bins: ${minBinId} → ${maxBinId} (${binRange} bins)`);
    console.log(`      minDeltaId: ${minBinId - activeBinId}, maxDeltaId: ${maxBinId - activeBinId}`);
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
      let percent = opts.useBalance;
      if (percent.endsWith('%')) percent = percent.slice(0, -1);
      const p = parseFloat(percent);
      if (isNaN(p) || p <= 0 || p > 100) {
        console.error('Invalid --use-balance value. Use something like 50% or 0.75');
        process.exit(1);
      }
      const factor = p > 1 ? p / 100 : p;
      tokenAmountOut = rawBalance.mul(new BN(Math.floor(factor * 1_000_000))).div(new BN(1_000_000));
      console.log(`  Using ${p}% of balance → ${tokenAmountOut.toString()} raw units`);
    } else if (opts.tokenAmount) {
      tokenAmountOut = new BN(opts.tokenAmount);
      console.log(`  Using provided token amount: ${tokenAmountOut.toString()} (raw units)`);
      if (tokenAmountOut.gt(rawBalance)) {
        console.warn('  ⚠ Warning: Requested amount is higher than your current balance.');
      }
    } else {
      tokenAmountOut = rawBalance;
    }
  } else {
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
      tokenAmountOut = new BN('1000000000');
    }
  }

  // 5. DLMM SDK call
  console.log('[5/5] Preparing DLMM SDK call...');

  const { StrategyType, toStrategyParameters, getBinArrayAccountMetasCoverage } = await import('@meteora-ag/dlmm');

  let sdkStrategyType = StrategyType.Spot;
  if (opts.strategy === 'scalp-spike') sdkStrategyType = StrategyType.Spot;
  if (opts.strategy === 'evil-panda')   sdkStrategyType = StrategyType.Spot;

  const isTokenXSol = dlmm.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';
  const isTokenYSol = dlmm.tokenY.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';

  const totalX = isTokenXSol ? new BN(0) : tokenAmountOut;
  const totalY = isTokenYSol ? new BN(0) : tokenAmountOut;

  console.log('\n=== DLMM Call Parameters (for diagnosis) ===');
  console.log('activeBinIdNum     :', activeBinIdNum);
  console.log('binStep            :', dlmm.lbPair.binStep);
  console.log('minBinId           :', minBinId);
  console.log('maxBinId           :', maxBinId);
  console.log('range width (bins) :', maxBinId - minBinId + 1);
  console.log('minDeltaId         :', minBinId - activeBinIdNum);
  console.log('maxDeltaId         :', maxBinId - activeBinIdNum);
  console.log('strategy (range)   :', opts.strategy);
  console.log('totalX             :', totalX.toString());
  console.log('totalY             :', totalY.toString());
  console.log('================================================\n');

  // === Split path: shared between --simulate and --split (real) ===
  // This function is the canonical implementation used by both modes.
  async function runSplitPath(dryRunOverride: boolean) {
    const DEFAULT_BIN_PER_POSITION = 70;
    const MAX_RESIZE_LENGTH = 91;
    const desiredWidth = maxBinId - minBinId + 1;
    const initialWidth = Math.min(DEFAULT_BIN_PER_POSITION, desiredWidth);

    const solBefore = await getSolBalance(connection, wallet.publicKey);
    const tokenBefore = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
    console.log(`  Balances before position creation: SOL ${solBefore} | Token ${tokenBefore}`);

    console.log('\n  ⚠️  WARNING: Creating a DLMM position will lock SOL as rent (~0.10–0.20 SOL typical for wide ranges).');
    console.log('     This rent is recoverable when you close the position, but only if the position is empty.');

    // Step 1: initializePosition2 + increasePositionLength2 (in one tx)
    const initIx = await dlmm.program.methods
      .initializePosition2(minBinId, initialWidth)
      .accountsPartial({
        payer: wallet.publicKey,
        position: positionKeypair.publicKey,
        lbPair: poolPubkey,
        owner: wallet.publicKey,
      })
      .instruction();

    const extendIxs: any[] = [];
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

    if (dryRunOverride) {
      console.log('  [DRY RUN] Would send initializePosition2 + increasePositionLength2 — skipped.');
      console.log(`    initialWidth: ${initialWidth}, extensions: ${extendIxs.length}`);
    } else {
      const createTx = new Transaction().add(initIx, ...extendIxs);
      createTx.feePayer = wallet.publicKey;
      const { blockhash: bh1 } = await connection.getLatestBlockhash();
      createTx.recentBlockhash = bh1;

      const createSig = await connection.sendTransaction(createTx, [wallet, positionKeypair]);
      await connection.confirmTransaction(createSig, 'confirmed');
      console.log('  ✓ Position created + extended. Sig:', createSig);
      if (extendIxs.length > 0) {
        console.log(`    (Used ${extendIxs.length} increasePositionLength2 instruction(s))`);
      }
    }

    const solAfterCreate = await getSolBalance(connection, wallet.publicKey);
    const tokenAfterCreate = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
    console.log(`  Balances after position creation (before liquidity): SOL ${solAfterCreate} | Token ${tokenAfterCreate}`);

    // Step 2: Resolve (or initialize) bitmap extension
    const binArrayBitmapExtension = await resolveBitmapExtension(
      connection, dlmm, poolPubkey, wallet, dryRunOverride
    );

    // Step 3: addLiquidityByStrategy2 (the canonical low-level path)
    console.log('  Adding liquidity via low-level addLiquidityByStrategy2...');
    try {
      await sendAddLiquidityByStrategy2({
        connection,
        wallet,
        dlmm,
        poolPubkey,
        positionPubkey: positionKeypair.publicKey,
        minBinId,
        maxBinId,
        totalX,
        totalY,
        sdkStrategyType,
        getBinArrayAccountMetasCoverage,
        toStrategyParameters,
        binArrayBitmapExtension,
        tokenXProgramId: resolvedTokenXProgram,
        tokenYProgramId: resolvedTokenYProgram,
        dryRun: dryRunOverride,
      });
    } catch (liqErr: any) {
      console.error('  ❌ Low-level liquidity addition failed:');
      console.error('     ', liqErr?.message || liqErr);
      if (liqErr?.logs) console.error('     Logs:', liqErr.logs);
    }

    const solAfterLiq = await getSolBalance(connection, wallet.publicKey);
    const tokenAfterLiq = await getTokenBalance(connection, wallet.publicKey, outputMint, tokenProgram);
    console.log(`  Balances after liquidity attempt: SOL ${solAfterLiq} | Token ${tokenAfterLiq}`);

    // Step 4: Inspect final on-chain position state
    if (!dryRunOverride) {
      try {
        const userPositions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
        const ourPosition = userPositions?.userPositions?.find(
          (p: any) => p.publicKey?.toBase58?.() === positionKeypair.publicKey.toBase58()
        );

        if (ourPosition?.positionData) {
          const pd = ourPosition.positionData;
          const lower = pd.lowerBinId ?? 'n/a';
          const upper = pd.upperBinId ?? 'n/a';
          const totalLiquidity = (pd as any).totalLiquidity ?? 'n/a';
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
    }
  }

  if (opts.simulate) {
    console.log('\n=== SIMULATION MODE (Split Path) ===\n');
    try {
      await runSplitPath(false); // simulate = real sends but small/guarded
      console.log('\n✅ SPLIT path completed (see balances + position inspection above).');
    } catch (err: any) {
      console.error('❌ SPLIT path failed:');
      console.error('   ', err?.message || err);
      if (err?.logs) console.error('   Logs:', err.logs);
    }
    console.log('\n=== End of simulation ===');
    return;
  }

  if (opts.dryRun) {
    console.log('\n=== DRY RUN MODE (Split Path) ===\n');
    try {
      await runSplitPath(true);
      console.log('\n✅ DRY RUN completed — no transactions were sent.');
    } catch (err: any) {
      console.error('❌ DRY RUN failed during build:', err?.message || err);
    }
    return;
  }

  // Real execution
  console.log('⚠️  REAL EXECUTION MODE');

  if (opts.split) {
    console.log('\n=== REAL SPLIT EXECUTION (position + liquidity) ===\n');
    try {
      await runSplitPath(false);
      console.log('\n✅ Real split open completed.');
    } catch (err: any) {
      console.error('❌ Real split open failed:', err?.message || err);
      if (err?.logs) console.error('Logs:', err.logs);
    }
  } else {
    // Fallback: combined initializePositionAndAddLiquidityByStrategy (narrow ranges only)
    const params = {
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: sdkStrategyType,
      },
    };
    try {
      await dlmm.initializePositionAndAddLiquidityByStrategy(params as any);
      console.log('✅ Real combined open succeeded.');
    } catch (err: any) {
      console.error('❌ Real combined open failed:', err?.message || err);
    }
  }
}

/**
 * Attempt to close a bin array to recover the rent.
 * The bin array must be completely empty (no liquidity).
 */
async function closeBinArray(lbPairAddress: string, binArrayAddress: string) {
  const connection = getConnection();
  const wallet = getWallet();

  const lbPairPubkey = new PublicKey(lbPairAddress);
  const binArrayPubkey = new PublicKey(binArrayAddress);

  console.log(`\n=== Close Bin Array ===`);
  console.log(`LB Pair: ${lbPairAddress}`);
  console.log(`Bin Array: ${binArrayAddress}`);
  console.log(`Rent Receiver: ${wallet.publicKey.toBase58()}`);

  try {
    const dlmm = await DLMM.create(connection, lbPairPubkey);

    try {
      await dlmm.program.account.binArray.fetch(binArrayPubkey);
      console.log(`Bin Array loaded. (You can inspect it further on Solscan if needed.)`);
    } catch (e) {
      console.log(`Could not fetch bin array state (it may already be closed or invalid).`);
    }

    const ix = await dlmm.program.methods
      .closeBinArray()
      .accountsPartial({
        lbPair: lbPairPubkey,
        binArray: binArrayPubkey,
        rentReceiver: wallet.publicKey,
        signer: wallet.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(wallet);

    console.log('Sending close_bin_array transaction...');
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, 'confirmed');

    console.log('\n✅ Bin array closed successfully!');
    console.log('Signature:', sig);
    console.log('Rent should now be returned to your wallet.');
  } catch (err: any) {
    console.error('\n❌ Failed to close bin array:');
    console.error('   ', err?.message || err);

    if (err?.logs) {
      console.error('\nProgram Logs:');
      console.error(err.logs);
    }

    console.log('\nCommon reasons this fails:');
    console.log('  - The bin array still contains liquidity');
    console.log('  - You are not authorized to close this bin array');
    console.log('  - The bin array does not exist or was already closed');
  }
}

main().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});
