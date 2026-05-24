import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false });

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { BN } from '@coral-xyz/anchor';
import bs58 from 'bs58';

const LB_PAIR = new PublicKey('BGRTiYMPfpfYANXxbAsgTW7KMPt6DTjahEytAZDvFwi3');

const BIN_ARRAYS: { pubkey: string; index: number }[] = [
  { pubkey: '36QZbSpHKq5kdVmxo7te6V4HyG5nBRFy3gXqLCg3bU1q', index: -16 },
  { pubkey: '5arSdgVByJ2viV7GtARWvBsTHudAPST2YWBF84AqZbuR', index: -15 },
  { pubkey: '5d9GhW5X1d6Q4Mshri5qfbMFBMJ1pseFZLTVigjvuKRq', index: -14 },
  { pubkey: 'GfJG48vkvMqnkuvzAsLFodcohT5WSzZbrPKgezvv6MLu', index: -13 },
];

async function main() {
  const rpcUrl = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) throw new Error('WALLET_PRIVATE_KEY is not set in .env.local');
  const wallet = raw.startsWith('[')
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    : Keypair.fromSecretKey(bs58.decode(raw));

  console.log('Wallet:', wallet.publicKey.toBase58());

  const dlmm = await DLMM.create(connection, LB_PAIR);

  let recovered = 0;

  for (const { pubkey, index } of BIN_ARRAYS) {
    const binArrayPubkey = new PublicKey(pubkey);
    console.log(`\nClosing bin array index ${index}: ${pubkey}`);
    try {
      const tx = await dlmm.closeBinArrayIfEmpty(
        new BN(index),
        wallet.publicKey,
      );
      const sig = await connection.sendTransaction(tx, [wallet], {
        skipPreflight: false,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`  ✅ Closed. Sig: ${sig}`);
      recovered += 0.07143744;
    } catch (err: any) {
      console.log(`  ❌ Failed: ${err.message}`);
      // If closeBinArrayIfEmpty doesn't exist on the SDK object,
      // log available methods:
      if (err.message?.includes('is not a function')) {
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(dlmm))
          .filter(m => m.toLowerCase().includes('close') || m.toLowerCase().includes('bin'));
        console.log('  Available close/bin methods on dlmm:', methods);
      }
    }
  }

  console.log(`\nTotal recovered: ${recovered.toFixed(6)} SOL`);
}

main().catch(console.error);