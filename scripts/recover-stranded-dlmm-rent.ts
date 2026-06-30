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
 * The script:
 * - prints on-chain dataLen + first16 for every ghost
 * - always prefers dlmmPool.program.methods.closePosition() to emit a correct ix (disc + accounts)
 * - falls back to a single known-good raw close_position instruction
 * - never guesses close_position_v2
 * - does NOT call initialize by default (TRY_INIT_GHOSTS only for when you have the lost keypairs)
 *
 * Prevention (already in bot): atomic createAccount + initializePosition in one tx.
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
import { getDLMM, getInitializePositionAccounts } from '@/bot/executor/utils';
import { tryCloseEmptyPosition } from '@/bot/executor/open';
import { getPendingScaffolds, removePendingScaffold } from '@/bot/executor/persistence';
import { Keypair, Transaction } from '@solana/web3.js';
import { ComputeBudgetProgram } from '@solana/web3.js';
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
  const closeDisc = getAnchorDiscriminator('close_position');
  const initDisc = getAnchorDiscriminator('initialize_position');

  console.log(`[disc] computed close_position: [${closeDisc.join(', ')}]`);
  console.log(`[disc] computed initialize_position: [${initDisc.join(', ')}]`);

  // The published @meteora-ag/dlmm package rarely ships a dlmm.json IDL (only built JS).
  // We still try; if present we print everything useful. Primary source of truth for a
  // valid close ix is the *SDK builder* (dlmmPool.program.methods.closePosition) at runtime.
  let idlCloseDisc: Buffer | null = null;
  try {
    const fs = require('fs');
    const pkgDir = path.join(process.cwd(), 'node_modules/@meteora-ag/dlmm');
    let idlPath = path.join(pkgDir, 'dist/idl/dlmm.json');
    if (!fs.existsSync(idlPath)) idlPath = path.join(pkgDir, 'idl/dlmm.json');
    if (fs.existsSync(idlPath)) {
      const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
      console.log('[disc] === IDL instructions (from package if present) ===');
      for (const ix of (idl.instructions || [])) {
        const n = (ix.name || '').toLowerCase();
        if (n.includes('close') || n.includes('initialize') || n.includes('position')) {
          const d = ix.discriminator ? Buffer.from(ix.discriminator) : null;
          if (d) {
            console.log(`  ${ix.name}: [${[...d].join(', ')}]`);
            if (!idlCloseDisc && n.includes('close')) idlCloseDisc = d;
          }
        }
      }
    } else {
      console.log('[disc] No dlmm.json in package (normal). Relying on SDK .methods builder for real close disc + accounts.');
    }
  } catch (e) {
    console.log('[disc] IDL load skipped:', (e as any)?.message || e);
  }

  return {
    close: idlCloseDisc || closeDisc,
    initialize: initDisc,
  };
}

const DISCRIMINATORS = loadDiscriminators();

// Note: account size differs for Position vs newer layout, but the *close instruction*
// is the same (SDK builder emits the correct disc for the deployed program).
function isLargePosition(dataLen: number | undefined): boolean {
  return !!dataLen && dataLen >= 18200;
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
  const hasRange = typeof minBinId === 'number' && typeof maxBinId === 'number';

  // Resolve token mints + their actual TOKEN_PROGRAM_ID (legacy vs 2022)
  let tokenXMint = SystemProgram.programId;
  let tokenYMint = SystemProgram.programId;
  let tokenXProgram = TOKEN_PROGRAM_ID;
  let tokenYProgram = TOKEN_PROGRAM_ID;

  if (dlmmPool?.tokenX?.publicKey) tokenXMint = dlmmPool.tokenX.publicKey;
  if (dlmmPool?.tokenY?.publicKey) tokenYMint = dlmmPool.tokenY.publicKey;

  const resolveTokenProgram = async (mint: PublicKey): Promise<PublicKey> => {
    if (mint.toBase58() === 'So11111111111111111111111111111111111111112') return TOKEN_PROGRAM_ID;
    try {
      const mi = await conn.getAccountInfo(mint);
      return mi?.owner ?? TOKEN_PROGRAM_ID;
    } catch { return TOKEN_PROGRAM_ID; }
  };
  tokenXProgram = await resolveTokenProgram(tokenXMint);
  tokenYProgram = await resolveTokenProgram(tokenYMint);

  const userTokenX = getAssociatedTokenAddressSync(tokenXMint, wallet.publicKey, false, tokenXProgram);
  const userTokenY = getAssociatedTokenAddressSync(tokenYMint, wallet.publicKey, false, tokenYProgram);

  const ataIxs: TransactionInstruction[] = [];
  try {
    if (!(await conn.getAccountInfo(userTokenX))) {
      ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userTokenX, wallet.publicKey, tokenXMint, tokenXProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }
    if (!(await conn.getAccountInfo(userTokenY))) {
      ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userTokenY, wallet.publicKey, tokenYMint, tokenYProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }
  } catch {}

  // Bitmap (always derivable)
  let binArrayBitmapExtension = SystemProgram.programId;
  try {
    const [bmp] = PublicKey.findProgramAddressSync([Buffer.from('bitmap'), lbPair.toBuffer()], DLMM_PROGRAM_ID);
    binArrayBitmapExtension = bmp;
  } catch {}

  // Bin arrays: only when range known; otherwise placeholder (close will hit position deserial error for ghosts anyway)
  let binArrayLower = SystemProgram.programId;
  let binArrayUpper = SystemProgram.programId;
  if (hasRange) {
    try {
      const { getBinArraysRequiredByPositionRange } = await import('@meteora-ag/dlmm');
      const BN = (await import('bn.js')).default;
      const req = getBinArraysRequiredByPositionRange(lbPair, new BN(minBinId), new BN(maxBinId), DLMM_PROGRAM_ID);
      if (req?.length) {
        binArrayLower = req[0].key;
        binArrayUpper = req[req.length - 1].key;
      }
    } catch {}
  }

  let reserveX = (dlmmPool as any)?.reserveX ?? SystemProgram.programId;
  let reserveY = (dlmmPool as any)?.reserveY ?? SystemProgram.programId;

  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    DLMM_PROGRAM_ID
  )[0];

  // === PRIMARY: let the installed SDK build the close ix (with full accounts) ===
  // Supplying the complete accounts map prevents "Account `xxx` not provided" from the builder.
  // We include rentReceiver (newer DLMM versions require it for the rent from the closed position account).
  // The emitted ix will have the exact disc + ordering the current @meteora-ag/dlmm expects.
  if (dlmmPool && dlmmPool.program && typeof dlmmPool.program.methods?.closePosition === 'function') {
    try {
      const closeMethod = dlmmPool.program.methods.closePosition;

      const accounts = {
        position: positionPubkey,
        lbPair,
        binArrayBitmapExtension,
        userTokenX,
        userTokenY,
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        binArrayLower,
        binArrayUpper,
        sender: wallet.publicKey,
        tokenXProgram,
        tokenYProgram,
        eventAuthority,
        program: DLMM_PROGRAM_ID,
        rentReceiver: wallet.publicKey,  // required in current DLMM closePosition (receives closed rent)
        owner: wallet.publicKey,
      };

      // Use accountsPartial if available (more lenient for ghost/uninitialized positions)
      const builder = closeMethod();
      const builtIx = await (typeof builder.accountsPartial === 'function'
        ? builder.accountsPartial(accounts)
        : builder.accounts(accounts)
      ).instruction();

      const emittedDisc = [...builtIx.data.slice(0, 8)];
      console.log(`  [SDK-BUILD] closePosition ix built. emitted disc=[${emittedDisc.join(', ')}] (range=${hasRange})`);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));

      for (const a of ataIxs) tx.add(a);
      tx.add(builtIx);

      tx.feePayer = wallet.publicKey;
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      return await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
    } catch (sdkBuildErr: any) {
      console.log('  [SDK-BUILD] dlmmPool.program.methods.closePosition failed to build ix:', sdkBuildErr?.message || sdkBuildErr);
    }
  }

  // === FALLBACK: manual raw using the one known good close_position disc ===
  const closeDiscriminator = DISCRIMINATORS.close;

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
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));
  ataIxs.forEach(a => tx.add(a));
  tx.add(ix);
  tx.feePayer = wallet.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  try {
    return await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
  } catch (sendErr: any) {
    if (sendErr instanceof SendTransactionError || sendErr?.getLogs) {
      try {
        const logs = sendErr.logs || (await sendErr.getLogs?.(conn));
        if (logs?.length) console.log('  SendTransactionError full logs:\n' + logs.map((l: string) => '    ' + l).join('\n'));
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
      .accounts(
        getInitializePositionAccounts(dlmmPool, wallet.publicKey, positionPubKey, dlmmPool.pubkey)
      )
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
  console.log(`[disc] using close disc (IDL or computed) = [${[...DISCRIMINATORS.close].join(', ')}]`);
  console.log(`
NOTE ON GHOSTS (root cause + status):
- These 5 are create-only shells (rent paid, LBUZ owner, zero data). close always 0xbba (deserial). init requires the original position Keypair as signer.
- For THESE specific accounts the rent (~0.64 SOL total) is unrecoverable without the lost ephemeral keypairs. 20+ runs with correct discs, builder, raw, high prio, ATAs etc. all confirm the same terminal errors.
- NEW: the bot now persists the position secret *before* any create RPC (in open.ts + pending-position-scaffolds.json). monitor retry + this script will auto-init (with real signer) + close for any future partial ghosts.
- Prevention is now the focus. Old ghosts without persisted secrets stay lost.

We use SDK builder first (full accounts) + known close disc. No v2 guessing.
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

    // If the running bot persisted a secret for this pubkey (new prevention), use it here for a real init (with signer).
    try {
      const pending = getPendingScaffolds().find((p: any) => p.pubkey === s.pubkey);
      if (pending && Array.isArray(pending.secret) && pending.secret.length === 64) {
        const kp = Keypair.fromSecretKey(Uint8Array.from(pending.secret));
        const lower = typeof s.minBin === 'number' ? s.minBin : 0;
        const w = (typeof s.maxBin === 'number' && typeof s.minBin === 'number') ? (s.maxBin - s.minBin) : 140;
        console.log(`  [recovery] pending secret found — initializing with signer lower=${lower} width=${w}`);
        const initIx = await dlmmPool.program.methods
          .initializePosition(lower, w)
          .accounts(
            getInitializePositionAccounts(dlmmPool, wallet.publicKey, pub, lbPair)
          )
          .instruction();
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));
        tx.add(initIx);
        tx.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet, kp], { commitment: 'confirmed' });
        console.log(`  [recovery] initialized with secret ✔ ${sig}`);
        removePendingScaffold(s.pubkey);
      }
    } catch (e: any) {
      console.log(`  [recovery] secret init skipped/failed: ${e?.message || e}`);
    }

    // 1. SDK path (tryCloseEmptyPosition). For ghosts (no range) we know dlmmPool.closePosition() will throw inside the SDK
    // (TypeError on .publicKey because it assumes valid position data). Skip straight to raw for no-range to keep output clean.
    let recovered = false;
    const hasRange = typeof s.minBin === 'number' && typeof s.maxBin === 'number';
    if (dlmmPool && typeof dlmmPool.closePosition === 'function' && hasRange) {
      try {
        console.log(`  Trying SDK path via tryCloseEmptyPosition (dlmmPool.closePosition) ...`);
        const sdkCloseOk = await tryCloseEmptyPosition(
          dlmmPool,
          pub,
          wallet,
          s.minBin,
          s.maxBin,
          `[recover-${s.pubkey.slice(0,8)}]`,
          300000 // high prio
        );
        console.log(`  SDK tryClose returned success=${sdkCloseOk}`);
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

    // Fetch on-chain state for diagnostics (size + leading bytes tell us if a Position was ever written).
    const posInfo = await connection.getAccountInfo(pub).catch(() => null);
    const dataLen = posInfo?.data?.length || 0;
    const first16 = posInfo?.data ? Buffer.from(posInfo.data.slice(0, 16)).toString('hex') : 'n/a';
    console.log(`  on-chain dataLen=${dataLen} first16=${first16}  (large=${isLargePosition(dataLen)})`);

    if (!recovered) {
      // Always prefer SDK builder inside closeGhostPositionRaw (it will emit the real disc + correct accounts).
      // No v2 guessing: the close ix is one instruction; Position layout variant does not change the ix discriminator.
      console.log(`  Attempting raw/SDK closePosition (SDK builder first for correct disc+accounts) + high prio...`);
      try {
        const sig = await closeGhostPositionRaw(connection, wallet, pub, lbPair, dlmmPool, s.minBin, s.maxBin);
        console.log(`  ✔ Recovered via raw close`);
        console.log(`  Sig: ${sig}`);
        console.log(`  Explorer: https://explorer.solana.com/tx/${sig}`);
        recovered = true;
      } catch (rawErr: any) {
        console.error(`  Raw/SDK close failed: ${rawErr?.message || rawErr}`);
        // Always dump full logs when available.
        let logs: string[] = [];
        if (rawErr instanceof SendTransactionError || rawErr?.getLogs || rawErr?.logs) {
          try {
            logs = rawErr.logs || (await rawErr.getLogs?.(connection)) || [];
            if (logs?.length) console.log('  SendTransactionError full logs:\n' + logs.map((l: string) => '    ' + l).join('\n'));
          } catch {}
        }

        const msg = (rawErr?.message || '') + ' ' + logs.join(' ');
        const isDiscMismatch = msg.includes('AccountDiscriminatorMismatch') || msg.includes('0xbba') || logs.some((l: string) => l.includes('0xbba') || l.includes('AccountDiscriminatorMismatch'));
        const isFallback = msg.includes('InstructionFallbackNotFound') || msg.includes('0x65') || logs.some((l: string) => l.includes('FallbackNotFound') || l.includes('0x65'));

        if (isDiscMismatch) {
          console.log(`
  >>> AccountDiscriminatorMismatch (0xbba / 3002) on position.
  first16=${first16} dataLen=${dataLen}.
  Ghost: createAccount succeeded (rent paid, owner=LBUZ, correct size) but initializePosition was NEVER completed.
  closePosition (the only close ix) ALWAYS does Anchor deserial of the Position account first.
  Zero data (or wrong disc bytes) => hard 0xbba.
`);
        } else if (isFallback) {
          console.log(`
  >>> InstructionFallbackNotFound (0x65).
  The 8-byte prefix sent did not match any registered instruction on the deployed program.
  (Previous runs using a guessed "close_position_v2" disc hit exactly this.)
  We now only send the disc emitted by the real SDK builder or the known close_position disc.
`);
        }

        console.log(`
  >>> CONCLUSION FOR THIS GHOST: unrecoverable from this wallet.
  - initializePosition requires the position pubkey to be a *signer* (IDL).
  - The ephemeral Keypair used at create time is lost (only pubkey was saved).
  - Without that keypair we cannot init, and without init close always 0xbba.
  - If you ever find the original 5 position keypairs (the Keypair objects, not just pubkeys), we can do [wallet, posKeypair] init then close.
  Manual recovery via key ${s.pubkey} (e.g. using a recovered keypair or direct program hack) is the only path.
`);
        if (!recovered) {
          console.warn(`  Position rent locked (0.128 SOL) — manual recovery needed via key ${s.pubkey}`);
        }
      }
    }
  }

  console.log('\nRecovery attempts complete.');
  console.log('Each ghost locks ~0.128 SOL. These 5 are not reclaimable without the original position Keypairs.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});