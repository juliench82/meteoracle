/**
 * scripts/recover-stranded-dlmm-rent.ts
 *
 * One-off recovery for stranded createAccount-only position accounts (ghosts).
 * These have rent paid (account assigned to LBUZ program) but initializePosition never succeeded
 * (data remains zeroed, ~0.128 SOL rent locked per account).
 *
 * CRITICAL UNDERSTANDING:
 * - The position accounts were created using a fresh Keypair (the "position keypair").
 * - The createAccount tx required that keypair to sign (standard for keypair-owned new accounts).
 * - initializePosition was never successfully called, so no Position struct (with its Anchor discriminator) was written.
 * - closePosition (and remove) always deserialize the position account as `Position`; zero data => AccountDiscriminatorMismatch (0xbba).
 * - initializePosition's IDL declares the `position` account as `signer`. The on-chain handler / its CPIs require the signer privilege on that pubkey.
 * - Without the original ephemeral position Keypair's private key, we cannot provide a valid signature for the position account.
 * - Patching isSigner:false lets the tx send, but then the program rejects with "signer privilege escalated" / "unauthorized signer or writable account" (because it expected/used the position as signer).
 *
 * Result: these ghosts cannot be initialized or closed from the wallet alone.
 * The rent is unrecoverable unless you can recover the original position keypairs for these exact pubkeys.
 *
 * The script will attempt raw close (shows the clear 0xbba) and, by default, will NOT auto-attempt init (it always fails the same way).
 * Set TRY_INIT_GHOSTS=true to force the init attempts (for diagnosis only).
 *
 * Prevention (already in bot): atomic createAccount + initializePosition in one tx + finally { tryClose + persist for monitor }.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.worker.json scripts/recover-stranded-dlmm-rent.ts
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
  SYSVAR_RENT_PUBKEY,
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
  let closeDisc = getAnchorDiscriminator('close_position');
  let closeV2Disc = getAnchorDiscriminator('close_position_v2');
  let initDisc = getAnchorDiscriminator('initialize_position');

  console.log(`[disc] computed close_position:    [${closeDisc.join(', ')}]`);
  console.log(`[disc] computed close_position_v2: [${closeV2Disc.join(', ')}]`);
  console.log(`[disc] computed initialize_position: [${initDisc.join(', ')}]`);

  // When the real IDL is loadable, the code below will print the exact bytes the *installed package* declares
  // and will prefer those over our name-based hash for the close instructions.

  let foundCloseV2FromIdl = false;

  // Load the real IDL that was used to build the on-chain program and use the *exact* discriminator bytes it declares.
  try {
    const fs = require('fs');
    const pkgDir = path.join(process.cwd(), 'node_modules/@meteora-ag/dlmm');
    let idlPath = path.join(pkgDir, 'dist/idl/dlmm.json');
    if (!fs.existsSync(idlPath)) idlPath = path.join(pkgDir, 'idl/dlmm.json');
    if (fs.existsSync(idlPath)) {
      const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
      console.log('[disc] === Real IDL instructions from installed @meteora-ag/dlmm ===');
      for (const ix of (idl.instructions || [])) {
        if (/close.*position|position.*close/i.test(ix.name)) {
          const d = ix.discriminator ? Buffer.from(ix.discriminator) : null;
          if (d) {
            console.log(`  ${ix.name} (IDL): [${[...d].join(', ')}]`);
            // Prefer any instruction that looks like the V2 close
            if (/v2|2$/i.test(ix.name) && !foundCloseV2FromIdl) {
              closeV2Disc = d;
              foundCloseV2FromIdl = true;
            } else if (!/v2|2$/i.test(ix.name)) {
              // keep the non-v2 as the default close
              closeDisc = d;
            }
          }
        }
        if (/^initializePosition$/i.test(ix.name) || /initialize.*position/i.test(ix.name)) {
          if (ix.discriminator) {
            initDisc = Buffer.from(ix.discriminator);
            console.log(`  ${ix.name} (IDL): [${[...initDisc].join(', ')}]`);
          }
        }
      }
    }
  } catch (e) {
    console.log('[disc] Could not load real IDL from package, using computed discriminators only.');
  }

  return {
    close: closeDisc,
    closeV2: closeV2Disc,
    initialize: initDisc,
  };
}

const DISCRIMINATORS = loadDiscriminators();

// Simple heuristic: V2 positions are larger
function isLikelyV2(dataLen: number | undefined): boolean {
  return !!dataLen && dataLen >= 18200; // 18304 observed for V2
}

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
  // Use the version-appropriate discriminator chosen by main() based on observed on-chain dataLen.
  // main() also prints the actual first 16 bytes of the position data so we can see the real discriminator (or zeros).
  const closeDiscriminator = (globalThis as any).__CHOSEN_CLOSE_DISC
    || DISCRIMINATORS.closeV2
    || DISCRIMINATORS.close;

  // If we have a dlmmPool, prefer letting the SDK build the close instruction (correct disc + correct account metas for the installed SDK version).
  // This is much safer than our hand-rolled list, especially for V2.
  if (dlmmPool && dlmmPool.program && typeof dlmmPool.program.methods?.closePosition === 'function') {
    try {
      // Try the V2 method first if we decided we want V2, otherwise the regular one.
      const methodName = (globalThis as any).__CHOSEN_CLOSE_DISC === DISCRIMINATORS.closeV2
        ? 'closePositionV2'
        : 'closePosition';

      const closeMethod = (dlmmPool.program.methods as any)[methodName];
      if (typeof closeMethod === 'function') {
        const builtIx = await closeMethod()
          .accounts({
            position: positionPubkey,
            lbPair: lbPair,
            // The SDK will fill the rest (bin arrays, reserves, token accounts, event authority, etc.)
          })
          .instruction();

        // Add priority fees + any ATA creates we decided we needed.
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));

        // We still want the ATAs created if they don't exist (the SDK close may assume they do for fee claiming).
        // (the ataIxs block below will still run for that)

        tx.add(builtIx);
        tx.feePayer = wallet.publicKey;
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;

        return await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
      }
    } catch (sdkBuildErr) {
      console.log("  SDK could not build close ix, falling back to manual raw list:", (sdkBuildErr as any)?.message || sdkBuildErr);
    }
  }

  // --- fallback: manual raw instruction (what we had before) ---

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

  const userTokenX = getAssociatedTokenAddressSync(tokenXMint, wallet.publicKey, false, tokenXProgram);
  const userTokenY = getAssociatedTokenAddressSync(tokenYMint, wallet.publicKey, false, tokenYProgram);

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

  let binArrayLower = SystemProgram.programId;
  let binArrayUpper = SystemProgram.programId;
  let binArrayBitmapExtension = SystemProgram.programId;

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

  let reserveX = SystemProgram.programId;
  let reserveY = SystemProgram.programId;
  if (dlmmPool) {
    if ((dlmmPool as any).reserveX) reserveX = (dlmmPool as any).reserveX;
    if ((dlmmPool as any).reserveY) reserveY = (dlmmPool as any).reserveY;
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

/**
 * tryInitializeGhost
 *
 * Attempts to call initializePosition on a pre-created but zero-data ghost.
 * This is almost always doomed for these accounts because:
 * - We don't have the original position Keypair.
 * - The instruction requires that keypair to sign (position account is "signer" in the IDL).
 *
 * We only call this if TRY_INIT_GHOSTS=true (for diagnosis).
 * It will log the exact signer escalation and the explanation.
 */
async function tryInitializeGhost(
  dlmmPool: any,
  positionPubKey: PublicKey,
  wallet: any,
  minBinId: number | undefined,
  maxBinId: number | undefined,
  label: string,
  connection: any
): Promise<{ success: boolean; lower?: number; width?: number }> {
  let lower = minBinId;
  let width = (typeof minBinId === 'number' && typeof maxBinId === 'number') ? (maxBinId - minBinId) : undefined;

  if (typeof lower !== 'number' || typeof width !== 'number' || width <= 0) {
    // Guess a range around current active bin (width ~140 like the known case)
    try {
      const active = await dlmmPool.getActiveBin();
      lower = active.binId - 70;
      width = 140;
      if (lower < -1000) lower = Math.max(0, active.binId - 70); // some pools dislike very negative; adjust if init fails
      console.log(`${label} no range provided — guessing around active bin ${active.binId}: lower=${lower} width=${width}`);
    } catch (e) {
      console.log(`${label} could not guess range for init, skipping init step`);
      return { success: false };
    }
  }

  try {
    console.log(`${label} attempting initializePosition (lower=${lower}, width=${width}) to materialize the ghost...`);

    // Build the ix first
    let initIx = await dlmmPool.program.methods
      .initializePosition(lower, width)
      .accounts({
        payer: wallet.publicKey,
        position: positionPubKey,
        lbPair: dlmmPool.pubkey,
        owner: wallet.publicKey,
        rent: SYSVAR_RENT_PUBKEY,
        program: dlmmPool.program.programId,
      })
      .instruction();

    // Patch for pre-created ghost: force the position to NOT be a signer.
    // The IDL/builder marks it signer for the "new keypair" case.
    // For ghosts we set isSigner=false so the tx does not require a signature for the position pubkey
    // (we only have the wallet key). This avoids the "signer privilege escalated" / "unauthorized signer" runtime errors.
    initIx.keys = initIx.keys.map((k: any) => {
      if (k.pubkey.equals(positionPubKey)) {
        return { pubkey: k.pubkey, isSigner: false, isWritable: true };
      }
      return k;
    });

    // Build tx from scratch with patched ix (budgets first, then the init ix).
    // This guarantees the serialized message has the position with isSigner=false.
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));
    tx.add(initIx);

    tx.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    console.log(`${label} ghost initialized ✔ ${sig}`);
    return { success: true, lower, width };
  } catch (e: any) {
    console.error(`${label} initialize failed: ${e?.message || e}`);
    if (e?.logs) console.log('  init logs:', e.logs);
    const msg = (e?.message || '') + ' ' + (e?.logs || []).join(' ');
    if (msg.includes('signer privilege escalated') || msg.includes('unauthorized signer or writable account')) {
      console.log(`
  >>> The "signer privilege escalated" / "unauthorized signer" on InitializePosition is expected.
  The instruction requires the position pubkey to be a signer (IDL declares it signer; the program and any CPIs it makes require the privilege).
  We patched isSigner=false and only signed with the wallet, so the runtime lets the tx in but the program/CPI rejects because it didn't get the expected signer flag on the position.
  Without a signature from the original Keypair that corresponds to this position address, there is no way to call initializePosition successfully.
  (That keypair was generated at open time with Keypair.generate() and only the pubkey was kept in state/logs.)
`);
    }
    return { success: false };
  }
}

async function main() {
  const wallet = getWallet();
  const connection = getConnection();
  const DLMM = await getDLMM();

  console.log(`Recovering ${STRANDED.length} stranded DLMM position accounts...`);
  console.log(`[disc] using close disc = [${DISCRIMINATORS.close.join(', ')}]`);
  console.log(`
NOTE ON GHOSTS: These position accounts have data length but zero content (no Anchor Position discriminator).
initializePosition requires the position pubkey to be a *signer* in the tx (IDL + program logic/CPI).
We have no private key for these (they were ephemeral Keypairs at open time, only pubkey was persisted).
Without that sig, init fails with "signer privilege escalated".
Without init, close always fails deserial with 0xbba.
By default we only do raw close (shows the clear error). Set TRY_INIT_GHOSTS=true only for extra diagnostics.
If you ever recover the original position keypairs, we can sign init with [wallet, positionKeypair].
`);
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

    // 1. SDK path (tryCloseEmptyPosition). For ghosts (no range) we know dlmmPool.closePosition() will throw inside the SDK
    // (TypeError on .publicKey because it assumes valid position data). Skip straight to raw for no-range to keep output clean.
    let recovered = false;
    const hasRange = typeof s.minBin === 'number' && typeof s.maxBin === 'number';
    if (dlmmPool && typeof dlmmPool.closePosition === 'function' && hasRange) {
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
    } else if (!hasRange) {
      console.log(`  Skipping SDK closePosition for ghost (no range) -- it throws inside the SDK on zero data. Going to raw.`);
    }

    // Fetch on-chain data for this position so we can pick V1 vs V2 close and show the actual discriminator bytes on chain.
    const posInfo = await connection.getAccountInfo(pub).catch(() => null);
    const dataLen = posInfo?.data?.length || 0;
    const first16 = posInfo?.data ? Buffer.from(posInfo.data.slice(0, 16)).toString('hex') : 'n/a';
    const useV2 = isLikelyV2(dataLen);
    const chosenDisc = useV2 ? (DISCRIMINATORS.closeV2 || DISCRIMINATORS.close) : DISCRIMINATORS.close;
    console.log(`  on-chain dataLen=${dataLen} first16=${first16} → using ${useV2 ? 'close_position_v2' : 'close_position'}`);

    if (!recovered) {
      // Raw close with version-appropriate disc. We do not auto-try initializePosition (requires lost position keypair as signer).
      try {
        console.log(`  Trying raw ${useV2 ? 'closePositionV2' : 'closePosition'} with correct discriminator + high prio...`);
        (globalThis as any).__CHOSEN_CLOSE_DISC = chosenDisc;
        const sig = await closeGhostPositionRaw(connection, wallet, pub, lbPair, dlmmPool, s.minBin, s.maxBin);
        console.log(`  ✔ Recovered via raw close`);
        console.log(`  Sig: ${sig}`);
        console.log(`  Explorer: https://explorer.solana.com/tx/${sig}`);
        recovered = true;
      } catch (rawErr: any) {
        console.error(`  Raw failed: ${rawErr?.message || rawErr}`);
        // Extra: full SendTransactionError details as recommended
        let logs: string[] = [];
        if (rawErr instanceof SendTransactionError || rawErr?.getLogs || rawErr?.logs) {
          try {
            logs = rawErr.logs || (await rawErr.getLogs?.(connection)) || [];
            if (logs?.length) console.log("  SendTransactionError full logs:\n" + logs.map((l: string) => "    " + l).join("\n"));
          } catch {}
        }
        const isDiscMismatch = (rawErr?.message || '').includes('AccountDiscriminatorMismatch') ||
          (rawErr?.message || '').includes('0xbba') ||
          logs.some((l: string) => l.includes('AccountDiscriminatorMismatch') || l.includes('0xbba'));

        if (isDiscMismatch) {
          console.log(`
  >>> AccountDiscriminatorMismatch (0xbba / 3002) on the position account.
  On-chain first 16 bytes: ${first16} (dataLen=${dataLen}).
  The account was created (rent paid, owned by LBUZ, correct size) but initializePosition was never successfully executed (or used the wrong V1/V2 variant).
  The close instruction (V1 or V2) deserializes as a Position struct; the leading bytes don't match.
  initializePosition cannot be used — it requires the position pubkey to be a signer (lost ephemeral Keypair from create time).
  Without the original key for this exact pubkey you cannot write the discriminator and cannot close.
  These specific ghosts are not recoverable from the current wallet with normal DLMM instructions.
  (If you recover the position keypairs, we can add code to sign init txs with [wallet, positionKeypair].)
`);
        }

        if (!recovered) {
          console.warn(`  Position rent may be locked (manual recovery needed via key ${s.pubkey})`);
        }
      } finally {
        delete (globalThis as any).__CHOSEN_CLOSE_DISC;
      }
    }
  }

  console.log('\nRecovery attempts complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});