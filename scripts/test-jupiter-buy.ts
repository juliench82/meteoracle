/**
 * Isolated test for Jupiter SOL -> token buy (the exact pre-swap the bot does).
 * Run with: cd meteoracle && npx tsx scripts/test-jupiter-buy.ts <mint> [amountLamports]
 *
 * Example from logs: npx tsx scripts/test-jupiter-buy.ts 3G8zFxHA 33112582
 *
 * This bypasses all bot logic (range gates, state, etc.) and just does the quote + swap attempts
 * with the same params + patience the bot uses.
 */

const JUPITER_API = process.env.JUPITER_QUOTE_API_URL || 'https://public.jupiterapi.com';
const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

const SWAP_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1500;

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = SWAP_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function main() {
  const mint = process.argv[2];
  const amount = process.argv[3] || '33112582'; // default from the $tupid-SOL log

  if (!mint) {
    console.error('Usage: npx tsx scripts/test-jupiter-buy.ts <outputMint> [amountLamports]');
    console.error('Example: npx tsx scripts/test-jupiter-buy.ts 3G8zFxHA 33112582');
    process.exit(1);
  }

  console.log(`=== Isolated Jupiter Buy Test ===`);
  console.log(`API base: ${JUPITER_API}`);
  console.log(`Buying: ${amount} lamports SOL → ${mint}`);
  console.log(`Params: onlyDirectRoutes=false, restrictIntermediateTokens=true`);
  console.log(`Patience: up to ${MAX_RETRIES} attempts with escalating backoff + fresh quotes`);
  console.log('');

  const slippages = [500, 1000, 2000, 5000]; // include a high one for last resort

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const slippage = slippages[Math.min(attempt - 1, slippages.length - 1)];
    const delay = BASE_BACKOFF_MS * attempt;

    console.log(`\n--- Attempt ${attempt}/${MAX_RETRIES} @ ${slippage}bps ---`);

    try {
      // 1. Pre-quote (fresh every time for isolation)
      const quoteParams = new URLSearchParams({
        inputMint: NATIVE_MINT,
        outputMint: mint,
        amount,
        slippageBps: slippage.toString(),
        onlyDirectRoutes: 'false',
        restrictIntermediateTokens: 'true',
      });
      const quoteUrl = `${JUPITER_API}/quote?${quoteParams}`;
      console.log(`Quote URL: ${quoteUrl}`);

      const quoteRes = await fetchWithTimeout(quoteUrl);
      if (!quoteRes.ok) {
        const body = await quoteRes.text();
        throw new Error(`Quote HTTP ${quoteRes.status}: ${body}`);
      }
      const quote = await quoteRes.json();
      if (quote?.error || quote?.errorCode) {
        throw new Error(`Quote error: ${quote.error || quote.errorCode}`);
      }
      const outAmount = quote.outAmount ?? quote.out_amount;
      console.log(`Pre-quote OK: ${amount} SOL → ~${outAmount} token (impact=${quote.priceImpactPct ?? 'n/a'})`);
      console.log(`Route hops: ${Array.isArray(quote.routePlan) ? quote.routePlan.length : 1}`);

      // Small settle like the bot
      if (attempt > 1) {
        console.log(`Settling ${delay}ms before /swap...`);
        await new Promise(r => setTimeout(r, delay));
      }

      // 2. /swap with the (fresh) quoteResponse
      const swapBody = {
        quoteResponse: quote,
        userPublicKey: '11111111111111111111111111111111', // placeholder - we won't sign, just simulate
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      };

      const swapRes = await fetchWithTimeout(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(swapBody),
      });

      if (!swapRes.ok) {
        const body = await swapRes.text();
        throw new Error(`Swap HTTP ${swapRes.status}: ${body}`);
      }

      const swapData = await swapRes.json();
      if (swapData?.error) {
        throw new Error(`Swap error: ${swapData.error}`);
      }

      console.log(`Swap tx built successfully (simulation would be next in real tx).`);
      console.log(`If you see this, the route was executable for Jupiter's /swap builder.`);
      console.log(`Full swap response keys: ${Object.keys(swapData).join(', ')}`);

      // In real bot we would deserialize, sign, send.
      // Here we stop at building the tx to isolate the 0x177e (which happens in simulation/send).
      console.log(`\nSUCCESS on attempt ${attempt}: Jupiter was willing to build a swap tx.`);
      console.log(`In the bot the failure is usually in simulation of the Route ix (0x177e).`);
      process.exit(0);

    } catch (err: any) {
      const msg = err.message || String(err);
      const is177e = msg.includes('0x177e') || msg.includes('custom program error') || msg.includes('route not executable');
      console.warn(`Attempt ${attempt} FAILED${is177e ? ' (0x177e)' : ''}: ${msg}`);

      if (attempt < MAX_RETRIES) {
        console.log(`Waiting ${delay}ms before next attempt...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error(`\nAll ${MAX_RETRIES} attempts exhausted with 0x177e / route errors.`);
  console.error(`This reproduces the exact symptom the bot sees on this mint/amount right now.`);
  console.error(`Pre-quotes succeed, but /swap cannot produce an executable tx.`);
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
