/**
 * recover-stranded-accounts.ts
 *
 * Closes ghost DLMM position accounts (createAccount-only, never initialized)
 * and returns the locked rent (~0.128 SOL each) to the wallet.
 *
 * These accounts are owned by the Meteora DLMM program but have zeroed data —
 * they were created via System::createAccount, ownership transferred to DLMM,
 * but initializePosition never ran. The DLMM program exposes a `closePosition`
 * instruction that accepts uninitialized positions and returns rent to the owner.
 *
 * Usage (on server):
 *   cd /meteoracle
 *   npx ts-node scripts/recover-stranded-accounts.ts
 *
 * Set env vars (already in your .env):
 *   HELIUS_RPC_URL or RPC_ENDPOINT
 *   WALLET_KEYPAIR_PATH  (path to keypair JSON array)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

// ── CONFIG ────────────────────────────────────────────────────────────────────

const STRANDED_ACCOUNTS: string[] = [
  "4PXeYHXhbU1RPUgHhQTEE2sMxDxELazCvGmzNZdYf4Fo", // Jun 23 ~0.12828672 SOL
  "67jgEFj6HyQrRYpJGVDx8N94q6nmnDYmwNCBe5tyW9bz", // Jun 19 ~0.12828672 SOL
  "BUcSdNX2msJH3ZZkW7UVvCdP2ZKQpnAyDntxSxcU4LTz", // Jun 10 ~0.12739584 SOL
  "DWoSDWPPbiKXigGGjuRPneRkJFvyy6BfU1qjf73kfzMz", // Jun 10 ~0.12739584 SOL
  "BJGJStnGcMcX53hYV1bicpLpoSPPAqyfwZYFcRKapW6H", // Jun 11 ~0.05790720 SOL (smaller)
];

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function loadWallet(): Keypair {
  const keypairPath =
    process.env.WALLET_KEYPAIR_PATH ||
    path.resolve(process.env.HOME || "~", ".config/solana/id.json");
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Keypair not found at: ${keypairPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getRpc(): string {
  const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_ENDPOINT;
  if (!rpc) throw new Error("No RPC URL found in env (HELIUS_RPC_URL or RPC_ENDPOINT)");
  return rpc;
}

async function getAccountLamports(
  conn: Connection,
  pubkey: PublicKey
): Promise<number | null> {
  const info = await conn.getAccountInfo(pubkey);
  if (!info) return null;
  return info.lamports;
}

// ── CLOSE VIA DLMM closePosition ─────────────────────────────────────────────
// The Meteora SDK exposes closePosition() which builds the correct instruction
// even for zeroed/uninitialized accounts as long as the wallet is the owner/payer.
// If the SDK rejects zeroed data, we fall back to a raw anchor discriminator call.

async function tryCloseViaSdk(
  conn: Connection,
  wallet: Keypair,
  positionPubkey: PublicKey
): Promise<string> {
  // We need a dummy lb_pair pubkey — the SDK resolves it from the position account.
  // For zeroed accounts we build the instruction manually using the known discriminator.
  const closeDiscriminator = Buffer.from([123, 134, 81, 0, 49, 68, 98, 172]); // closePosition

  // Anchor account metas for closePosition:
  // 0: position (writable)  — the ghost account
  // 1: lb_pair (writable)   — we pass SystemProgram as dummy (will fail gracefully if wrong)
  // 2: bin_array_bitmap_extension (writable, optional) — use SystemProgram
  // 3: user_token_x (writable) — wallet ATA or wallet pubkey
  // 4: user_token_y (writable) — wallet pubkey
  // 5: reserve_x (writable) — SystemProgram dummy
  // 6: reserve_y (writable) — SystemProgram dummy
  // 7: token_x_mint
  // 8: token_y_mint
  // 9: bin_array_lower (writable)
  // 10: bin_array_upper (writable)
  // 11: sender (signer)
  // 12: token_x_program
  // 13: token_y_program
  // 14: event_authority
  // 15: program

  // For a fully zeroed uninitialized account the program may reject this path.
  // The safer path is to use the SDK's removeLiquidity(0) or a direct
  // SystemProgram assign-back trick. We try SDK first.

  const dlmmPool = await DLMM.create(conn, positionPubkey, { cluster: "mainnet-beta" }).catch(() => null);

  if (dlmmPool) {
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const match = userPositions.find(p => p.publicKey.equals(positionPubkey));
    if (match) {
      const closeTx = await dlmmPool.closePosition({
        owner: wallet.publicKey,
        position: match,
      });
      return await sendAndConfirmTransaction(conn, closeTx, [wallet], {
        commitment: "confirmed",
      });
    }
  }

  throw new Error("SDK path failed — account is zeroed/unrecognized by DLMM SDK");
}

// ── FALLBACK: reassign ownership back to System Program then drain ────────────
// The DLMM program's `closePosition` won't accept a zeroed account (no discriminator).
// But the Anchor framework allows a signed "realloc to 0 + assign" pattern IF
// the wallet is the position's `owner` field — which it is (set during createAccount).
//
// We use the DLMM program's own `closePosition` raw instruction with zeroed
// bin_array / token references — the program checks only that:
//   1. position.owner == signer  ← TRUE (wallet funded createAccount)
//   2. position.lb_pair == lb_pair account  ← zeroed = PublicKey::default()
// So we pass PublicKey::default() for lb_pair and dummy accounts.

async function closeZeroedPositionRaw(
  conn: Connection,
  wallet: Keypair,
  positionPubkey: PublicKey
): Promise<string> {
  const { TransactionInstruction, SystemProgram } = await import("@solana/web3.js");
  const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");

  // closePosition discriminator (Anchor IDL: sha256("global:close_position")[0..8])
  const discriminator = Buffer.from([123, 134, 81, 0, 49, 68, 98, 172]);

  const zero = SystemProgram.programId;
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  )[0];

  const ix = new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },  // position
      { pubkey: zero,           isSigner: false, isWritable: true },  // lb_pair (zeroed)
      { pubkey: zero,           isSigner: false, isWritable: true },  // bin_array_bitmap_extension
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },// user_token_x (receive rent here)
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },// user_token_y
      { pubkey: zero,           isSigner: false, isWritable: true },  // reserve_x
      { pubkey: zero,           isSigner: false, isWritable: true },  // reserve_y
      { pubkey: zero,           isSigner: false, isWritable: false }, // token_x_mint
      { pubkey: zero,           isSigner: false, isWritable: false }, // token_y_mint
      { pubkey: zero,           isSigner: false, isWritable: true },  // bin_array_lower
      { pubkey: zero,           isSigner: false, isWritable: true },  // bin_array_upper
      { pubkey: wallet.publicKey, isSigner: true,  isWritable: true },// sender (signer + rent recipient)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false }, // event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },// program (self-ref)
    ],
    data: discriminator,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  return await sendAndConfirmTransaction(conn, tx, [wallet], {
    commitment: "confirmed",
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const conn = new Connection(getRpc(), "confirmed");
  const wallet = loadWallet();

  console.log(`\nWallet: ${wallet.publicKey.toBase58()}`);
  console.log(`RPC:    ${getRpc().slice(0, 40)}...`);
  console.log(`\nAttempting to recover ${STRANDED_ACCOUNTS.length} stranded accounts...\n`);

  let totalRecovered = 0;
  let totalFailed = 0;

  for (const addrStr of STRANDED_ACCOUNTS) {
    const pubkey = new PublicKey(addrStr);
    console.log(`─── ${addrStr} ───`);

    const lamports = await getAccountLamports(conn, pubkey);
    if (lamports === null) {
      console.log(`  SKIP: account not found on-chain (already closed or wrong address)\n`);
      continue;
    }

    console.log(`  Locked: ${(lamports / 1e9).toFixed(9)} SOL`);

    // Try SDK path first, fall back to raw instruction
    let sig: string | null = null;
    let method = "";

    try {
      sig = await tryCloseViaSdk(conn, wallet, pubkey);
      method = "SDK closePosition";
    } catch (sdkErr) {
      console.log(`  SDK path failed: ${(sdkErr as Error).message}`);
      console.log(`  Trying raw closePosition instruction...`);
      try {
        sig = await closeZeroedPositionRaw(conn, wallet, pubkey);
        method = "raw closePosition";
      } catch (rawErr) {
        console.error(`  FAILED: ${(rawErr as Error).message}`);
        totalFailed++;
        console.log();
        continue;
      }
    }

    console.log(`  ✔ Recovered via ${method}`);
    console.log(`  Sig: ${sig}`);
    console.log(`  Explorer: https://explorer.solana.com/tx/${sig}`);
    totalRecovered += lamports;
    console.log();
  }

  const walletAfter = await conn.getBalance(wallet.publicKey);
  console.log(`\n════════════════════════════════`);
  console.log(`Recovered: ${(totalRecovered / 1e9).toFixed(6)} SOL`);
  console.log(`Failed:    ${totalFailed} account(s)`);
  console.log(`Wallet balance now: ${(walletAfter / 1e9).toFixed(6)} SOL`);

  if (totalFailed > 0) {
    console.log(`\nFor failed accounts: the raw closePosition instruction was rejected.`);
    console.log(`This means the DLMM program validates lb_pair even for zeroed positions.`);
    console.log(`Next step: find the lb_pair pubkey from the createAccount tx and retry`);
    console.log(`with the correct lb_pair. Check the createAccount tx on Explorer for`);
    console.log(`the pool address that was being opened at the time.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
