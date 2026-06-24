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
  // Full accurate list from consolidated createAccount scan (wallet GULXj8Fk...)
  // All are pure createAccount shells (SystemProgram.createAccount with owner=DLMM, zero data, rent locked).
  // Pools were recovered by correlating the create tx timestamp/slot with the closest prior/next DLMM Swap2 tx
  // on Solana Explorer (lb_pair is Account 1 / "Lb Pair" in the Swap2 instruction).
  // Bins unknown for most — only the Jun 23 one had a recorded range from earlier logs.

  {
    pubkey: '4PXeYHXhbU1RPUgHhQTEE2sMxDxELazCvGmzNZdYf4Fo',
    createSig: 'QRECnXorAaGqf7iW3hcRAfzRcC9NckcZQwY9BF4BKL8QSGUtc6Le5pCeuH7H37UnsPtE3SPmb1HFiMPqYDFctZ6',
    pool: 'NYKZsVV3nqq4VXFaGEbfxai3kCmFiXEgjxNeafrbZpJ',
    minBin: -734,
    maxBin: -594,
    note: 'Jun 23 2026 width-140 (known from logs)',
  },
  {
    pubkey: '67jgEFj6HyQrRYpJGVDx8N94q6nmnDYmwNCBe5tyW9bz',
    createSig: 'n4dcNbmMGoiQ2Y3nU9RGJpvn13NXBVPubodTtASfyF4yNhEarFMbUiBSy1TkBGe1ZorsMLiC3UF22jbG2JXWR4p',
    pool: 'F4azS6PdTRHANHoPnro3zZUFXiHQLqVhYKwzv7meKo4d',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 19 2026 F4az... (earlier log association) — bins unknown',
  },
  {
    pubkey: 'EHsvgQMWqZ26dKux8kreRC2tS14iZKyVFDDsuowE8nut',
    createSig: '4JQb6p5XZRBmf5BLUjxHQLe52kUKzaa8ojavVQ7u7f9T6abUo3Rrd1yB7WAwK62X86fTby6HV2W31HkraFqn7hMa',
    pool: '8EuDUisJsFyvyC61xmAVKASo5fCKGncfR8GKA2Fncx8s',
    sourceTx: '3t49cGqRXhnxoDPKDwXoLcpFudgMLEmgMwtRmGPdgfdeur2ZTmBnAS4kuTYbYNLAcA65DZXe2Hc8or61hsKQ4BEB',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 19 2026 Ranch-SOL — Swap2 13s after create',
  },
  {
    pubkey: 'BUcSdNX2msJH3ZZkW7UVvCdP2ZKQpnAyDntxSxcU4LTz',
    createSig: '3fdcbvJ5EcGHce8dbd28PSPbJzdq4vE6qYTPeQ1oacnUyZoFziLjmEQLRBWQeKyPce9ba5sUJK4qn6of2PTLDGML',
    pool: 'DYJCNWHcjANHxPcfLFxAhQHup1Q36Ccia5MyyHSK4avK',
    sourceTx: 'UFDN6W7WpeTXCUuyVQ9RV5vGUM3qGLENJ9kf3sGhawTvhYNsEKSitWfnYrTZcoFUQ6FzFmoh41JotAfaQC2FNti',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 10 2026 MMG-SOL — Swap2 (Lb Pair) 8s before create',
  },
  {
    pubkey: 'DWoSDWPPbiKXigGGjuRPneRkJFvyy6BfU1qjf73kfzMz',
    createSig: '3yv5UsMb1gDhGdDk6r6J3nCmrGmMgaRSQv1q3Bj9FJDcHhYKfy4znsWNNFVQtDUUpHxFCqjYoAk3irqLEQdLZQfz',
    pool: '2rLXrMvGta3TgveizhDjUgiHShJupw6srEboiAo6JbS2',
    sourceTx: '2q6dssRbN6muGe2gDJm23tCmnWamhW9KrQ4TzXmenHCwEZroosrSpT5iGYhDBhNUm2DHr9SQG2wgHh8Nh7bpQTYL',
    minBin: undefined,
    maxBin: undefined,
    note: 'Jun 10 2026 GO-SOL — Swap2 7s before create',
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

  // Always resolve the *actual* token program by reading the mint account's owner.
  // This is critical for Token-2022 mints (many meme pools) vs legacy SPL Token.
  // The dlmmPool.tokenX.tokenProgram is sometimes missing or incorrect.
  const resolveTokenProgram = async (mint: PublicKey): Promise<PublicKey> => {
    const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
    if (mint.toBase58() === NATIVE_SOL) return TOKEN_PROGRAM_ID;
    try {
      const mintInfo = await conn.getAccountInfo(mint);
      return mintInfo?.owner ?? TOKEN_PROGRAM_ID;
    } catch {
      return TOKEN_PROGRAM_ID;
    }
  };

  tokenXProgram = await resolveTokenProgram(tokenXMint);
  tokenYProgram = await resolveTokenProgram(tokenYMint);

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

  // Try to compute a real bitmap extension PDA (common for DLMM)
  try {
    const [bitmap] = PublicKey.findProgramAddressSync(
      [Buffer.from("bitmap"), lbPair.toBuffer()],
      DLMM_PROGRAM_ID
    );
    binArrayBitmapExtension = bitmap;
  } catch {}

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

  // Try to populate real reserve vaults (token accounts owned by the pair) from the dlmmPool if the SDK exposed them.
  // Placeholders often cause the close ix to fail with account constraints.
  let reserveX = SystemProgram.programId;
  let reserveY = SystemProgram.programId;
  if (dlmmPool) {
    if ((dlmmPool as any).reserveX) reserveX = (dlmmPool as any).reserveX;
    if ((dlmmPool as any).reserveY) reserveY = (dlmmPool as any).reserveY;
    // As a last resort, try to read from the lbPair account data (common offsets in Meteora DLMM)
    if (reserveX.equals(SystemProgram.programId) || reserveY.equals(SystemProgram.programId)) {
      try {
        const pairInfo = await conn.getAccountInfo(lbPair);
        if (pairInfo && pairInfo.data.length > 200) {
          // Heuristic: reserves are often two 32-byte pubkeys early in the struct after disc + other fields
          // This is best-effort; if wrong the close ix will give a clear constraint error.
          const d = pairInfo.data;
          // Try common offset for reserve_x (varies by version, around 40-100+)
          for (let off = 40; off < 120; off += 8) {
            if (d.length > off + 64) {
              const candX = new PublicKey(d.slice(off, off + 32));
              const candY = new PublicKey(d.slice(off + 32, off + 64));
              // Quick sanity: they should be owned by Token or Token-2022
              const ix = await conn.getAccountInfo(candX);
              if (ix && (ix.owner.toBase58().startsWith('Token') || ix.owner.equals(SystemProgram.programId))) {
                reserveX = candX;
                reserveY = candY;
                break;
              }
            }
          }
        }
      } catch {}
    }
  }

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
  console.log('Full list:');
  for (const s of STRANDED) {
    const src = (s as any).sourceTx ? `sourceTx=${(s as any).sourceTx.slice(0,16)}` : (s as any).createSig ? `createSig=${(s as any).createSig.slice(0,16)}` : '';
    console.log(`  ${s.pubkey.slice(0,8)}...  pool=${s.pool.slice(0,8)}...  ${s.note || ''}  ${src}`);
  }

  for (const s of STRANDED) {
    if (s.pool === 'REPLACE_WITH_POOL_ADDRESS') {
      console.warn(`Skipping ${s.pubkey.slice(0,8)} — pool not provided (createSig=${(s as any).createSig?.slice(0,12) || 'n/a'})`);
      continue;
    }
    const pub = new PublicKey(s.pubkey);
    const lbPair = new PublicKey(s.pool);
    const createNote = (s as any).createSig ? ` createSig=${(s as any).createSig.slice(0,12)}` : '';
    console.log(`\n=== Attempting reclaim for ${s.pubkey.slice(0,8)} on pool ${s.pool.slice(0,8)} ${s.note ? '(' + s.note + ')' : ''}${createNote}`);

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