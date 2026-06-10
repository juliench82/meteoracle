/**
 * Isolated test: Attempt a *direct* swap on a Meteora DLMM pool (bypassing Jupiter entirely).
 * This is a simple on-chain swap transaction test on the identified DLMM pool for the token.
 *
 * Run: cd meteoracle && npx tsx scripts/test-direct-dlmm-swap.ts <POOL_ADDRESS> [amountInLamports]
 *
 * Examples from recent logs:
 *   npx tsx scripts/test-direct-dlmm-swap.ts Ho2S88w9kPg3HLuEgJeV2nwRRbHaNE3ECFdq7Rf62N35 10000000
 *   npx tsx scripts/test-direct-dlmm-swap.ts EoKUt4yA5Dr7aoo6eoiyCUF7YySddzpBZbytP9WMgPSp 10000000
 *
 * Uses the @meteora-ag/dlmm SDK we already depend on.
 * Does a tiny SOL -> token swap (or reverse) and *simulates* the tx (no real funds moved if you use a read-only or small test).
 * Safe for testing executability.
 */

import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getDLMM } from '../bot/executor/utils'; // reuse existing helper
import { getConnection } from '../lib/solana';

async function main() {
  const poolAddress = process.argv[2];
  const amountIn = process.argv[3] ? BigInt(process.argv[3]) : 10_000_000n; // ~0.01 SOL default for tiny test

  if (!poolAddress) {
    console.error('Usage: npx tsx scripts/test-direct-dlmm-swap.ts <DLMM_POOL_ADDRESS> [amountLamportsIn]');
    console.error('Example: npx tsx scripts/test-direct-dlmm-swap.ts Ho2S88w9kPg3HLuEgJeV2nwRRbHaNE3ECFdq7Rf62N35 10000000');
    process.exit(1);
  }

  console.log('=== Direct Meteora DLMM Swap Test (no Jupiter) ===');
  console.log(`Pool: ${poolAddress}`);
  console.log(`Test amount in: ${amountIn} lamports (~${Number(amountIn) / 1e9} SOL)`);
  console.log('This will build a swap tx on the DLMM and *simulate* it only (no send).');
  console.log('');

  const connection = getConnection();
  const DLMM = await getDLMM();
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));

  const activeBin = await dlmmPool.getActiveBin();
  console.log(`Active bin: ${activeBin.binId}, price: ${activeBin.price}`);

  // Determine sides. Assume we want to buy the non-SOL side with SOL (as in bot pre-swap).
  const solIsTokenX = dlmmPool.tokenX.publicKey.toBase58() === 'So11111111111111111111111111111111111111112';
  const inToken = solIsTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
  const outToken = solIsTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;

  console.log(`Swapping ${inToken.toBase58().slice(0,8)} (SOL side) -> ${outToken.toBase58().slice(0,8)}`);

  // Get bin arrays (required for swap)
  const binArrays = await dlmmPool.getBinArrays();

  // Get swap quote for exact in
  const swapYtoX = !solIsTokenX; // adjust based on which is Y
  const swapQuote = await dlmmPool.swapQuote(
    new BN(amountIn.toString()),
    swapYtoX,
    new BN(1), // min out, we'll use the quote's
    binArrays
  );

  console.log(`Swap quote: in=${swapQuote.inAmount}, out=${swapQuote.outAmount}, fee=${swapQuote.fee}`);

  if (swapQuote.outAmount.isZero()) {
    console.error('Quote gave 0 out — no liquidity on that side for this small test amount. Try larger or reverse direction.');
    process.exit(1);
  }

  // Build the swap transaction — use FULL fetched list (same hardening as prod paths) to avoid "Not enough account keys" for bin_array in SDK sim/builder.
  const binArrayKeysForSwap = binArrays.map((ba: any) => ba.publicKey);
  console.log(`[test-direct] using FULL ${binArrayKeysForSwap.length} bin array pubkeys for swap (fetched=${binArrays.length})`);
  const swapTx = await dlmmPool.swap({
    inToken,
    binArraysPubkey: binArrayKeysForSwap,
    inAmount: swapQuote.inAmount,
    lbPair: dlmmPool.pubkey,
    user: new PublicKey('11111111111111111111111111111111'), // dummy for build; we'll replace with real if sending
    minOutAmount: swapQuote.minOutAmount,
    outToken,
  });

  // For simulation, we need a real signer. Use a dummy keypair (tx will fail auth but simulation can check other errors).
  const dummyWallet = Keypair.generate();

  // Rebuild with proper user if needed, but for sim we can use the built tx and simulate with modified accounts if necessary.
  // Simpler: serialize and simulate the transaction as-is (the SDK builds it for the user provided).
  // To make simulation meaningful, we simulate the raw tx instructions.

  console.log('Built swap transaction. Now simulating...');

  try {
    // The swapTx from SDK is a Transaction or Versioned. Handle both.
    const txToSim = swapTx instanceof VersionedTransaction ? swapTx : new VersionedTransaction(swapTx.compileMessage ? swapTx.compileMessage() : swapTx);

    // For pure simulation without signing, use simulateTransaction on the message.
    const simulation = await connection.simulateTransaction(txToSim, {
      sigVerify: false,
      commitment: 'confirmed',
    });

    if (simulation.value.err) {
      console.error('Simulation FAILED:', simulation.value.err);
      console.error('Logs:', simulation.value.logs);
      console.log('\nThis means even a direct DLMM swap on this pool would fail right now (liquidity, hooks, compute, etc.).');
    } else {
      console.log('Simulation SUCCESS (no error).');
      console.log('Units consumed:', simulation.value.unitsConsumed);
      console.log('Logs (last few):', simulation.value.logs?.slice(-5));
      console.log('\nDirect DLMM swap looks executable for this small amount.');
      console.log('In a real test you would sign with a funded wallet and send a tiny amount.');
    }
  } catch (simErr) {
    console.error('Simulation threw:', simErr);
  }

  console.log('\nTest complete. This bypasses Jupiter completely and tests direct on-chain swap on the DLMM.');
}

main().catch(console.error);
