/**
 * scripts/recover-stranded-dlmm-rent.ts
 *
 * One-off recovery for stranded createAccount-only position accounts (ghosts).
 * These have rent paid (account assigned to LBUZ program) but were never initialized
 * with liquidity.
 *
 * Usage (recommended):
 *   npx tsx --tsconfig tsconfig.worker.json scripts/recover-stranded-dlmm-rent.ts
 *
 * The script auto-loads .env.local (same as the worker).
 * Edit the STRANDED list below with the pubkeys + their original pool + (optional) bin range.
 * If you don't know the exact bins, leave them undefined — it will use closePosition only.
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
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

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
    note: 'Jun 19 2026 - fill exact bins from old logs if known',
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
  // Get correct discriminator from IDL (run the extraction command if this is still wrong)
  const closeDiscriminator = Buffer.from([123, 134, 81, 0, 49, 68, 98, 172]);

  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  )[0];

  let binArrayLower = SystemProgram.programId;
  let binArrayUpper = SystemProgram.programId;
  let tokenXMint = SystemProgram.programId;
  let tokenYMint = SystemProgram.programId;
  let tokenXProgram = TOKEN_PROGRAM_ID;
  let tokenYProgram = TOKEN_PROGRAM_ID;

  if (dlmmPool && typeof minBinId === "number" && typeof maxBinId === "number") {
    try {
      const { getBinArraysRequiredByPositionRange } = await import("@meteora-ag/dlmm");
      const required = getBinArraysRequiredByPositionRange(lbPair, new (await import("bn.js")).default(minBinId), new (await import("bn.js")).default(maxBinId), DLMM_PROGRAM_ID);
      if (required.length > 0) {
        binArrayLower = required[0].key;
        binArrayUpper = required[required.length - 1].key;
      }
      tokenXMint = dlmmPool.tokenX.publicKey;
      tokenYMint = dlmmPool.tokenY.publicKey;
      // Get token programs if available
      if (dlmmPool.tokenX.tokenProgram) tokenXProgram = dlmmPool.tokenX.tokenProgram;
      if (dlmmPool.tokenY.tokenProgram) tokenYProgram = dlmmPool.tokenY.tokenProgram;
    } catch (e) {
      console.log("  Could not compute exact bin arrays, using dummies");
    }
  }

  const ix = new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },  // position
      { pubkey: lbPair,         isSigner: false, isWritable: true },  // lb_pair
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: true },  // bin_array_bitmap_extension
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true }, // user_token_x
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true }, // user_token_y
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: true },  // reserve_x
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: true },  // reserve_y
      { pubkey: tokenXMint, isSigner: false, isWritable: false },
      { pubkey: tokenYMint, isSigner: false, isWritable: false },
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true },// sender
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: closeDiscriminator,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  return await sendAndConfirmTransaction(conn, tx, [wallet], {
    commitment: "confirmed",
  });
}

async function main() {
  const wallet = getWallet();
  const connection = getConnection();
  const DLMM = await getDLMM();

  console.log(`Recovering ${STRANDED.length} stranded DLMM position accounts...`);

  for (const s of STRANDED) {
    if (s.pool === 'REPLACE_WITH_POOL_ADDRESS') {
      console.warn(`Skipping ${s.pubkey} — pool not provided`);
      continue;
    }
    const pub = new PublicKey(s.pubkey);
    const lbPair = new PublicKey(s.pool);
    console.log(`\n=== Attempting reclaim for ${s.pubkey.slice(0,8)} on pool ${s.pool.slice(0,8)} ${s.note ? '(' + s.note + ')' : ''}`);

    let dlmmPool = null;
    try {
      dlmmPool = await DLMM.create(connection, lbPair);
    } catch (e) {
      console.log(`  Warning: could not create DLMM pool object, will use fallback dummies for accounts`);
    }

    try {
      const sig = await closeGhostPositionRaw(connection, wallet, pub, lbPair, dlmmPool, s.minBin, s.maxBin);
      console.log(`  ✔ Recovered via raw closePosition`);
      console.log(`  Sig: ${sig}`);
      console.log(`  Explorer: https://explorer.solana.com/tx/${sig}`);
    } catch (e) {
      console.error(`  Failed: ${(e as Error).message}`);
      console.warn(`  Position rent may be locked (manual recovery needed via key ${s.pubkey})`);
    }
  }

  console.log('\nRecovery attempts complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});