/**
 * scripts/recover-stranded-dlmm-rent.ts
 *
 * One-off recovery for stranded createAccount-only position accounts (ghosts).
 * These have rent paid (account assigned to LBUZ program) but initializePosition never succeeded
 * (data remains zeroed, ~0.128 SOL rent locked per account).
 *
 * Usage (recommended on server with .env.local):
 *   npx tsx --tsconfig tsconfig.worker.json scripts/recover-stranded-dlmm-rent.ts
 *
 * The script auto-loads .env.local (same as the worker).
 * - Provide pool for each (from your open attempt logs or create tx context).
 * - Provide min/maxBin when known (from failure logs) to help bin array accounts.
 * - Prefers the SDK tryCloseEmptyPosition (used by bot/monitor), falls back to raw close with correct disc.
 * - Catches SendTransactionError and calls getLogs() for full details (per program errors).
 */

import * as dotenv from 'dotenv'
import * as path from 'path'

// Load .env.local exactly like worker.ts does
dotenv.config({
  path: path.resolve(process.cwd(), '.env.local'),
  override: false,
  quiet: true,
})

import { getConnection, getWallet } from '@/lib/solana';
import { getDLMM } from '@/bot/executor/utils';
import { tryCloseEmptyPosition } from '@/bot/executor/open';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SendTransactionError,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createHash } from 'crypto';

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Compute Anchor 8-byte discriminator the same way the program + SDK do.
function getAnchorDiscriminator(name: string): Buffer {
  // Anchor uses: sha256("global:" + instruction_name_in_snake_or_as_registered)[:8]
  // Most Meteora DLMM on-chain matches "close_position"
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function loadDiscriminators() {
  // Prefer computed (reliable). Fall back only if needed.
  const closeDisc = getAnchorDiscriminator('close_position');
  const initDisc = getAnchorDiscriminator('initialize_position');
  // Also try camelCase variants if the deployed program registered differently (rare)
  console.log(`[disc] close_position: [${closeDisc.join(', ')}]`);
  return {
    close: closeDisc,
    initialize: initDisc,
  };
}

const DISCRIMINATORS = loadDiscriminators();

const STRANDED = [
  {
    pubkey: '4PXeYHXhbU1RPUgHhQTEE2sMxDxELazCvGmzNZdYf4Fo',
    pool: 'NYKZsVV3nqq4VXFaGEbfxai3kCmFiXEgjxNeafrbZpJ', // from Jun 23 failure logs
    minBin: -734,
    maxBin: -594,
    note: 'Jun 23 2026 ███-SOL (width 140)',
  },
  {
    pubkey: '67jgEFj6HyQrRYpJGVDx8N94q6nmnDYmwNCBe5tyW9bz',
    pool: 'F4azS6PdTRHANHoPnro3zZUFXiHQLqVhYKwzv7meKo4d', // Ranch-SOL from history
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 19 2026 - fill exact bins from old logs if known (try width ~140 or from open context)',
  },
  {
    pubkey: 'BUcSdNX2msJH3ZZkW7UVvCdP2ZKQpnAyDntxSxcU4LTz',
    pool: 'REPLACE_WITH_POOL_ADDRESS',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 10 - replace pool',
  },
  {
    pubkey: 'DWoSDWPPbiKXigGGjuRPneRkJFvyy6BfU1qjf73kfzMz',
    pool: 'REPLACE_WITH_POOL_ADDRESS',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 10 - replace pool',
  },
];

async function closeGhostPositionRaw(
  conn: any,
  wallet: any,
  positionPubkey: PublicKey,
  lbPair: PublicKey,
  dlmmPool?: any,
  minBinId?: number,
  maxBinId?: number
): Promise<string> {
  // Always use the computed correct discriminator
  const closeDiscriminator = DISCRIMINATORS.close;

  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  )[0];

  // Resolve real token mints + programs from dlmmPool when available (critical)
  let tokenXMint = SystemProgram.programId;
  let tokenYMint = SystemProgram.programId;
  let tokenXProgram = TOKEN_PROGRAM_ID;
  let tokenYProgram = TOKEN_PROGRAM_ID;
  if (dlmmPool) {
    tokenXMint = dlmmPool.tokenX.publicKey;
    tokenYMint = dlmmPool.tokenY.publicKey;
    if (dlmmPool.tokenX.tokenProgram) tokenXProgram = dlmmPool.tokenX.tokenProgram;
    if (dlmmPool.tokenY.tokenProgram) tokenYProgram = dlmmPool.tokenY.tokenProgram;
  }

  // Proper user ATAs (close will claim any dust fees here)
  const userTokenX = getAssociatedTokenAddressSync(tokenXMint, wallet.publicKey, false, tokenXProgram);
  const userTokenY = getAssociatedTokenAddressSync(tokenYMint, wallet.publicKey, false, tokenYProgram);

  // Ensure the ATAs exist (idempotent, no-op + no extra rent if present). Critical for close to succeed on fee accounts.
  const ataIxs: TransactionInstruction[] = [];
  try {
    const infoX = await conn.getAccountInfo(userTokenX).catch(() => null);
    if (!infoX) {
      ataIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          userTokenX,
          wallet.publicKey,
          tokenXMint,
          tokenXProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    const infoY = await conn.getAccountInfo(userTokenY).catch(() => null);
    if (!infoY) {
      ataIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          userTokenY,
          wallet.publicKey,
          tokenYMint,
          tokenYProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  } catch {}

  // Bin arrays + bitmap extension: use real if range known, else fall back (may still work for ghosts)
  let binArrayLower = SystemProgram.programId;
  let binArrayUpper = SystemProgram.programId;
  let binArrayBitmapExtension = SystemProgram.programId;

  if (dlmmPool && typeof minBinId === "number" && typeof maxBinId === "number") {
    try {
      const { getBinArraysRequiredByPositionRange } = await import("@meteora-ag/dlmm");
      const BN = (await import("bn.js")).default;
      const required = getBinArraysRequiredByPositionRange(lbPair, new BN(minBinId), new BN(maxBinId), DLMM_PROGRAM_ID);
      if (required.length > 0) {
        binArrayLower = required[0].key;
        binArrayUpper = required[required.length - 1].key;
      }
    } catch (e) {
      console.log("  Could not compute bin arrays, using programId placeholders (may fail)");
    }
  }

  // Note: reserve_x / reserve_y are the pool's token vaults (can be derived or read from dlmmPool, but many closes accept the lbPair as proxy in constraints; use placeholder if unknown)
  // For best results prefer the SDK path. Raw is last-ditch for zeroed accounts.
  const reserveX = SystemProgram.programId;
  const reserveY = SystemProgram.programId;

  const ix = new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: binArrayBitmapExtension, isSigner: false, isWritable: true },
      { pubkey: userTokenX, isSigner: false, isWritable: true },
      { pubkey: userTokenY, isSigner: false, isWritable: true },
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: tokenXMint, isSigner: false, isWritable: false },
      { pubkey: tokenYMint, isSigner: false, isWritable: false },
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: closeDiscriminator,
  });

  const tx = new Transaction();
  // High prio to help land recovery
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));
  for (const a of ataIxs) tx.add(a);
  tx.add(ix);

  tx.feePayer = wallet.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  try {
    return await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed", skipPreflight: false });
  } catch (sendErr: any) {
    // As recommended: surface full logs from SendTransactionError
    if (sendErr instanceof SendTransactionError || sendErr?.logs || typeof sendErr?.getLogs === 'function') {
      try {
        const logs = sendErr.logs || (await sendErr.getLogs?.(conn));
        if (logs) console.log("  Full logs from SendTransactionError.getLogs():", logs);
      } catch {}
    }
    throw sendErr;
  }
}

async function main() {
  const wallet = getWallet();
  const connection = getConnection();
  const DLMM = await getDLMM();

  console.log(`Recovering ${STRANDED.length} stranded DLMM position accounts...`);
  console.log(`[disc] using close disc = [${DISCRIMINATORS.close.join(', ')}]`);

  for (const s of STRANDED) {
    if (s.pool === 'REPLACE_WITH_POOL_ADDRESS') {
      console.warn(`Skipping ${s.pubkey} — pool not provided`);
      continue;
    }
    const pub = new PublicKey(s.pubkey);
    const lbPair = new PublicKey(s.pool);
    console.log(`\n=== Attempting reclaim for ${s.pubkey.slice(0,8)} on pool ${s.pool.slice(0,8)} ${s.note ? '(' + s.note + ')' : ''}`);

    let dlmmPool: any = null;
    try {
      dlmmPool = await DLMM.create(connection, lbPair);
      console.log(`  DLMM pool loaded for ${lbPair.toBase58().slice(0,8)} (tokenX=${dlmmPool?.tokenX?.publicKey?.toBase58?.().slice(0,8)})`);
    } catch (e) {
      console.log(`  Warning: could not create DLMM pool object for raw path`);
    }

    // 1. Preferred: use the same path the bot uses for ghosts (skip remove if no bins, direct closePosition)
    let recovered = false;
    if (dlmmPool && typeof dlmmPool.closePosition === 'function') {
      try {
        console.log(`  Trying SDK path via tryCloseEmptyPosition (dlmmPool.closePosition) ...`);
        await tryCloseEmptyPosition(
          dlmmPool,
          pub,
          wallet,
          s.minBin,
          s.maxBin,
          `[recover-${s.pubkey.slice(0,8)}]`,
          300000 // high prio
        );
        // tryClose logs its own success/failure traces. Check on-chain to confirm reclaim.
        const after = await connection.getAccountInfo(pub).catch(() => null);
        if (!after || after.lamports === 0 || (after.data && after.data.length < 100)) {
          console.log(`  ✔ Appears reclaimed (account gone or zeroed).`);
          recovered = true;
        } else {
          console.log(`  (account still present after tryClose; may need raw fallback or was non-zero liq)`);
        }
      } catch (sdkErr: any) {
        console.error(`  SDK/tryClose path error: ${sdkErr?.message || sdkErr}`);
        if (sdkErr?.logs) console.log("  SDK logs:", sdkErr.logs);
        if (typeof sdkErr?.getLogs === 'function') {
          try { console.log("  SDK getLogs():", await sdkErr.getLogs(connection)); } catch {}
        }
      }
    }

    if (!recovered) {
      // 2. Fallback raw with correct disc (for true zeroed ghosts)
      try {
        console.log(`  Trying raw closePosition with correct discriminator + high prio...`);
        const sig = await closeGhostPositionRaw(connection, wallet, pub, lbPair, dlmmPool, s.minBin, s.maxBin);
        console.log(`  ✔ Recovered via raw closePosition`);
        console.log(`  Sig: ${sig}`);
        console.log(`  Explorer: https://explorer.solana.com/tx/${sig}`);
        recovered = true;
      } catch (rawErr: any) {
        console.error(`  Raw failed: ${rawErr?.message || rawErr}`);
        // Extra: full SendTransactionError details as recommended
        if (rawErr instanceof SendTransactionError || rawErr?.getLogs || rawErr?.logs) {
          try {
            const logs = rawErr.logs || (await rawErr.getLogs?.(connection));
            if (logs?.length) console.log("  SendTransactionError full logs:\n" + logs.map((l: string) => "    " + l).join("\n"));
          } catch {}
        }
        console.warn(`  Position rent may be locked (manual recovery needed via key ${s.pubkey})`);
      }
    }
  }

  console.log('\nRecovery attempts complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});