/**
 * bot/executor/open/pre-swap.ts
 *
 * Direct DLMM pre-swap (SOL → token leg) for Bid-Ask one-sided evil-panda positions.
 * Uses Meteora SDK swapQuote + swap on the target pool (no Jupiter).
 * Prefers actual on-chain delta over quoted for amountForPosition.
 *
 * Extracted verbatim from open.ts (swapSolToTokenDirectOnDlmm). No behavior change.
 */

import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
} from '@/lib/solana-tx'
import { getWalletTokenBalance } from '@/lib/swap'

/**
 * Direct SDK swap for the token leg (Bid-Ask pre-fund).
 * Returns the *actual* amount received (delta preferred) to use for addLiquidity.
 */
export async function swapSolToTokenDirectOnDlmm(
  dlmmPool: any,
  solLamports: bigint,
  outputMint: PublicKey,
  solIsTokenX: boolean,
  label: string
): Promise<bigint> {
  const connection = getConnection();
  const wallet = getWallet();

  const inToken = solIsTokenX ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey;
  const outToken = solIsTokenX ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey;

  console.log(`${label} [TRACE] [SWAP-FUNC-ENTER] Inside swapSolToTokenDirectOnDlmm — fetching fresh state for actual pre-swap.`);
  const activeBinAtSwap = await dlmmPool.getActiveBin();
  console.log(`${label} [TRACE] [SWAP-FUNC] activeBinAtSwap=${activeBinAtSwap.binId}`);
  console.log(`${label} [direct-dlmm] swapping ${solLamports} lamports SOL → token on DLMM pool (activeBin=${activeBinAtSwap.binId}, in=${inToken.toBase58().slice(0,8)}, out=${outToken.toBase58().slice(0,8)})`);

  // Pre-swap balance for debug (also captured for delta calc below)
  let preBalForDelta = 0n;
  try {
    preBalForDelta = await getWalletTokenBalance(outToken.toBase58());
    console.log(`${label} [TRACE] [SWAP-PRE-BAL] pre-swap ${outToken.toBase58().slice(0,8)} balance: ${preBalForDelta}`);
    console.log(`${label} [direct-dlmm] pre-swap ${outToken.toBase58().slice(0,8)} balance: ${preBalForDelta}`);
  } catch (e) { console.log(`${label} [TRACE] [SWAP-PRE-BAL] pre-swap balance read failed: ${e}`); }

  console.log(`${label} [TRACE] [SWAP-BINARRAYS] calling getBinArrays()...`);
  const binArrays = await dlmmPool.getBinArrays();
  console.log(`${label} [TRACE] [SWAP-BINARRAYS] fetched ${binArrays.length} bin arrays`);
  console.log(`${label} [direct-dlmm] fetched ${binArrays.length} bin arrays (for quote + swap on this pool; will pass FULL list to swap builder to satisfy Swap2 bin_array keys)`);

  // swapYtoX: true if swapping Y (the non-SOL if solIsTokenX false?) into X.
  // If solIsTokenX, SOL is X, we are swapping X (SOL) for Y (token) → swapYtoX = false
  // If !solIsTokenX, SOL is Y, swapping Y (SOL) for X (token) → swapYtoX = true
  const swapYtoX = !solIsTokenX;

  const inputAmountBN = new BN(solLamports.toString());
  console.log(`${label} [TRACE] [SWAP-QUOTE] calling swapQuote(input=${inputAmountBN.toString()}, swapYtoX=${swapYtoX}, slippage=500)`);
  const swapQuote = await dlmmPool.swapQuote(
    inputAmountBN,
    swapYtoX,
    new BN(500), // 5% slippage for pre-swap on volatile pools
    binArrays
  );
  const q = swapQuote as any;

  if (q.outAmount.isZero()) {
    console.log(`${label} [TRACE] [SWAP-QUOTE-ZERO] quote returned zero outAmount — will throw`);
    throw new Error('Direct DLMM swap quote gave zero output (insufficient liquidity on that side)');
  }

  const quotedIn = q.inAmount ?? inputAmountBN;
  console.log(`${label} [TRACE] [SWAP-QUOTE-OK] quote: in=${quotedIn} out=${q.outAmount} fee=${q.fee}`);
  console.log(`${label} [direct-dlmm] quote: in=${quotedIn} out=${q.outAmount} fee=${q.fee}`);

  // Limit to relevant bin arrays near active (full list can cause tx size or AccountNotEnoughKeys on wide pools).
  // Prefer quote's list if SDK provides it; otherwise take first few + active vicinity.
  const binArrayKeysForSwap = (q.binArraysPubkey && q.binArraysPubkey.length > 0)
    ? q.binArraysPubkey
    : binArrays.slice(0, 5).map((ba: any) => ba.publicKey);
  console.log(`${label} [TRACE] [SWAP-TX] calling dlmmPool.swap() with ${binArrayKeysForSwap.length} binArrayKeys`);
  console.log(`${label} [direct-dlmm] calling swap with limited ${binArrayKeysForSwap.length} bin array pubkeys (near active) to avoid tx size/AccountNotEnoughKeys`);
  const swapTx = await dlmmPool.swap({
    inToken,
    binArraysPubkey: binArrayKeysForSwap,
    inAmount: inputAmountBN,  // use the exact input we quoted for (more reliable than q.inAmount across SDK responses)
    lbPair: dlmmPool.pubkey,
    user: wallet.publicKey,
    minOutAmount: q.minOutAmount,
    outToken,
  });

  // The SDK returns a Transaction (legacy). Apply priority fee and send.
  const priorityFee = await getPriorityFee([dlmmPool.pubkey.toBase58(), wallet.publicKey.toBase58()]);
  const preparedTx = applyPriorityFee(swapTx, priorityFee);

  console.log(`${label} [TRACE] [SWAP-SEND] sending swap tx...`);
  const sig = await sendLegacyTx(preparedTx, [wallet], `${label} direct-dlmm-swap`);

  console.log(`${label} [TRACE] [SWAP-CONFIRMED] swap confirmed ✔ sig: ${sig}`);
  console.log(`${label} [direct-dlmm] swap confirmed ✔ sig: ${sig}`);

  // Read actual received (delta) + post balance for debug.
  // Prefer actual delta. QuotedOut is only fallback if delta==0 after polls (rare lag).
  // This prevents requesting more tokens in add than actually held.
  let postBal = 0n;
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 600));
      postBal = await getWalletTokenBalance(outToken.toBase58());
      console.log(`${label} [TRACE] [SWAP-POST-BAL-POLL] poll ${i+1}/4 postBal=${postBal}`);
      if (postBal > 0n) break;
    }
  } catch (e) { console.log(`${label} [TRACE] [SWAP-POST-BAL] post balance poll error: ${e}`); }
  const delta = postBal >= preBalForDelta ? postBal - preBalForDelta : 0n;

  const quotedOut = q?.outAmount && !q.outAmount.isZero() ? BigInt(q.outAmount.toString()) : 0n;
  // Prefer actual received delta over quotedOut. Only fall back to quoted if delta is 0 after polling (visibility lag).
  // Using quoted when actual is lower can cause addLiquidity to request more tokens than the wallet holds.
  const amountForPosition = delta > 0n ? delta : quotedOut;

  try {
    console.log(`${label} [TRACE] [SWAP-RESULT] post-swap ${outToken.toBase58().slice(0,8)} balance: ${postBal} (delta=${delta}, usedForLp=${amountForPosition}, quotedOut=${quotedOut || 'n/a'})`);
    console.log(`${label} [direct-dlmm] post-swap ${outToken.toBase58().slice(0,8)} balance: ${postBal} (delta=${delta}, usedForLp=${amountForPosition}, quotedOut=${quotedOut || 'n/a'})`);
  } catch {}
  return amountForPosition;
}
