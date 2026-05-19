/**
 * scripts/debug-meteora-pools.ts
 *
 * Diagnostic script to inspect what the Meteora DLMM SDK actually returns
 * for problematic pump.fun-originated pools (e.g. Coinini-SOL and TOESCOIN-SOL).
 *
 * This helps debug why the bot gets "Invalid public key input" during open,
 * even though the official Meteora UI can open positions on the same pools.
 *
 * Usage:
 *   npx tsx scripts/debug-meteora-pools.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';

const RPC =
  process.env.HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  'https://api.mainnet-beta.solana.com';

const connection = new Connection(RPC, 'confirmed');

const POOLS = [
  {
    label: 'Coinini-SOL (evil-panda accepted)',
    poolAddress: 'C5zW9LuGwuFBG7W5fXVQfTkryPkTAjEYVTD2RV5YtEAs',
  },
  {
    label: 'TOESCOIN-SOL (scalp-spike accepted)',
    poolAddress: 'E6MAQLdiP9R2TLo8Z66t4LUKhSA1HQuqVMLWGNyFDYf9',
  },
];

async function inspectPool(label: string, poolAddress: string) {
  console.log(`\n========== ${label} ==========`);
  console.log('Pool address:', poolAddress);

  let poolPubkey: PublicKey;
  try {
    poolPubkey = new PublicKey(poolAddress);
  } catch (e: any) {
    console.error('Invalid pool address (not base58):', e.message);
    return;
  }

  try {
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    // Use 'any' for debug output because the DLMM SDK types are complex
    // and change between versions. This is a temporary diagnostic tool.
    const debugPool: any = dlmmPool;

    const tokenX = debugPool.tokenX;
    const tokenY = debugPool.tokenY;

    const xPub = tokenX?.publicKey;
    const yPub = tokenY?.publicKey;

    console.log('\nDLMM SDK returned:');
    console.dir(
      {
        binStep: debugPool.lbPair?.binStep,
        tokenX: {
          publicKey: typeof xPub === 'string' ? xPub : xPub?.toBase58?.() ?? xPub,
          constructorName: xPub?.constructor?.name ?? typeof xPub,
          decimals: tokenX?.decimals,
          isPublicKeyInstance: xPub instanceof PublicKey,
        },
        tokenY: {
          publicKey: typeof yPub === 'string' ? yPub : yPub?.toBase58?.() ?? yPub,
          constructorName: yPub?.constructor?.name ?? typeof yPub,
          decimals: tokenY?.decimals,
          isPublicKeyInstance: yPub instanceof PublicKey,
        },
        lbPair: {
          mintX: debugPool.lbPair?.mintX?.toBase58?.() ?? debugPool.lbPair?.mintX,
          mintY: debugPool.lbPair?.mintY?.toBase58?.() ?? debugPool.lbPair?.mintY,
          tokenProgramX:
            debugPool.lbPair?.tokenProgramX?.toBase58?.() ??
            debugPool.lbPair?.tokenProgramX,
          tokenProgramY:
            debugPool.lbPair?.tokenProgramY?.toBase58?.() ??
            debugPool.lbPair?.tokenProgramY,
        },
      },
      { depth: 4 }
    );

    // Try to reproduce what getTokenProgramId() does
    console.log('\n--- Simulating getTokenProgramId(outputMint) ---');
    const outputMint = tokenX ? (tokenX.publicKey instanceof PublicKey ? tokenX.publicKey : new PublicKey(tokenX.publicKey)) : null;

    if (outputMint) {
      try {
        const info = await connection.getAccountInfo(outputMint);
        console.log('getAccountInfo succeeded for outputMint');
        console.log('Owner (token program):', info?.owner?.toBase58());
      } catch (err: any) {
        console.error('getAccountInfo on outputMint FAILED:', err.message);
      }
    } else {
      console.log('Could not determine a valid outputMint');
    }

  } catch (err: any) {
    console.error('Failed to load pool:', err.message);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    }
  }
}

async function main() {
  console.log('RPC in use:', RPC);
  for (const p of POOLS) {
    await inspectPool(p.label, p.poolAddress);
  }
  console.log('\nDone.');
}

main().catch(console.error);