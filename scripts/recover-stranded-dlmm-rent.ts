/**
 * scripts/recover-stranded-dlmm-rent.ts
 *
 * One-off recovery for stranded createAccount-only position accounts (ghosts).
 * These have rent paid (account assigned to LBUZ program) but were never initialized
 * with liquidity.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.worker.json scripts/recover-stranded-dlmm-rent.ts
 *
 * Edit the STRANDED list below with the pubkeys + their original pool + (optional) bin range.
 * If you don't know the exact bins, leave them undefined — it will use closePosition only.
 */

import { getConnection, getWallet } from '@/lib/solana';
import { getDLMM } from '@/bot/executor/utils';
import { tryCloseEmptyPosition } from '@/bot/executor/open';
import { PublicKey } from '@solana/web3.js';

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
    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(s.pool));
      const pub = new PublicKey(s.pubkey);
      console.log(`\n=== Attempting reclaim for ${s.pubkey.slice(0,8)} on pool ${s.pool.slice(0,8)} ${s.note ? '(' + s.note + ')' : ''}`);
      await tryCloseEmptyPosition(
        dlmmPool,
        pub,
        s.minBin,
        s.maxBin,
        wallet,
        `[manual-recover-${s.pubkey.slice(0,8)}]`,
        300000 // very high priority for recovery
      );
    } catch (e) {
      console.error(`Failed attempt for ${s.pubkey.slice(0,8)}:`, e);
    }
  }

  console.log('\nRecovery attempts complete. Check logs for success sigs or "may be locked" messages.');
  console.log('If closePosition succeeded, the rent should be back in your wallet.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});