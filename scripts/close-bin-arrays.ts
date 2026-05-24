/**
 * scripts/close-bin-arrays.ts
 *
 * Attempt to close bin array accounts to recover rent (user-funded bin arrays only).
 *
 * These 4 bin arrays were created as side-effects during experimental liquidity adds.
 * According to analysis, the correct user-facing instruction is `closeBinArrayIfEmpty`
 * (or the variant that checks the `funder` field rather than admin).
 *
 * The current on-chain instruction we have access to is `close_bin_array`.
 * If it returns InvalidAdmin, it means this wallet is not authorized under the
 * program's current access control for these specific accounts.
 *
 * Usage:
 *   npx tsx scripts/close-bin-arrays.ts
 */

import { Connection, PublicKey, Transaction, Keypair } from '@solana/web3.js';
import { getConnection, getWallet } from '@/lib/solana';
import DLMM from '@meteora-ag/dlmm';

const LB_PAIR = new PublicKey('BGRTiYMPfpfYANXxbAsgTW7KMPt6DTjahEytAZDvFwi3');

const BIN_ARRAYS_TO_CLOSE = [
  '5arSdgVByJ2viV7GtARWvBsTHudAPST2YWBF84AqZbuR',
  '5d9GhW5X1d6Q4Mshri5qfbMFBMJ1pseFZLTVigjvuKRq',
  'GfJG48vkvMqnkuvzAsLFodcohT5WSzZbrPKgezvv6MLu',
  '36QZbSpHKq5kdVmxo7te6V4HyG5nBRFy3gXqLCg3bU1q',
];

async function main() {
  console.log('=== Meteora DLMM Bin Array Rent Recovery ===\n');

  const connection = getConnection();
  const wallet = getWallet();

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`LB Pair: ${LB_PAIR.toBase58()}\n`);

  const dlmm = await DLMM.create(connection, LB_PAIR);

  let totalRecovered = 0;
  let successCount = 0;

  for (const address of BIN_ARRAYS_TO_CLOSE) {
    const binArrayPubkey = new PublicKey(address);
    console.log(`\n--- Attempting to close: ${address} ---`);

    try {
      // Try to fetch current state for info
      try {
        const binArrayAccount = await dlmm.program.account.binArray.fetch(binArrayPubkey);
        console.log(`  Bin array fetched successfully.`);
        // You could inspect binArrayAccount here if needed
      } catch (fetchErr: any) {
        console.log(`  Could not fetch bin array (may already be closed): ${fetchErr.message}`);
      }

      const ix = await dlmm.program.methods
        .closeBinArray()
        .accountsPartial({
          lbPair: LB_PAIR,
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

      console.log('  Sending closeBinArray transaction...');
      const sig = await connection.sendTransaction(tx, [wallet]);
      await connection.confirmTransaction(sig, 'confirmed');

      console.log(`  ✅ SUCCESS! Closed bin array.`);
      console.log(`     Signature: ${sig}`);
      successCount++;
      totalRecovered += 0.07143744; // approximate rent per bin array

    } catch (err: any) {
      console.error(`  ❌ Failed to close ${address}`);
      console.error(`     Error: ${err?.message || err}`);

      if (err?.logs) {
        console.error('     Program Logs:');
        console.error(err.logs);
      }

      // Check for specific known errors
      const errorMsg = err?.message || '';
      if (errorMsg.includes('InvalidAdmin') || errorMsg.includes('6015')) {
        console.log('     → Got InvalidAdmin (6015) from lb_access_control.rs.');
        console.log('       Per analysis, this indicates the instruction is enforcing an admin check.');
        console.log('       The correct user-facing close instruction may be closeBinArrayIfEmpty (or closeEmptyBinArrayAndTransferRent), which checks the funder field instead.');
        console.log('       If that variant exists in this program version, it should allow the original funder (your wallet) to close empty bin arrays.');
      } else if (errorMsg.includes('BinArrayIsNotEmpty') || errorMsg.includes('0x177')) {
        console.log('     → Bin array still contains liquidity. Empty it first.');
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Successfully closed: ${successCount} / ${BIN_ARRAYS_TO_CLOSE.length}`);
  console.log(`Approximate SOL recovered: ${totalRecovered.toFixed(6)} SOL`);
  console.log('\nNote: Any successfully closed accounts should have returned their rent to your wallet.');
}

main().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});