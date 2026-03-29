# Meteoracle Strategies

Each strategy is a self-contained TypeScript file exporting a `Strategy` object. Add a new file here and register it in `index.ts` to activate it.

---

## Strategy Comparison

| Strategy | Risk | Duration | Target | Range | Bin Step | SOL Bias |
|---|---|---|---|---|---|---|
| **Scalp Spike** | 🔴 High | < 12h | New launches, CT pumps | ±20% | 50 bps | 60% SOL |
| **Evil Panda** | 🟠 Medium | < 48h | Memecoins $200K–$50M MC | −80% / +20% | 100 bps | 80% SOL |
| **Stable Farm** | 🟢 Low | Up to 7d | SOL/USDC, deep pairs | ±10% Curve | 5 bps | 50/50 |

---

## Strategy Selection Logic

Strategies are evaluated **in priority order** — first match wins:

1. **Scalp Spike** — most selective, time-sensitive, checked first
2. **Evil Panda** — broad memecoin coverage
3. **Stable Farm** — catch-all for large established pairs

A token can only be deployed into one active strategy at a time.

---

## Adding a New Strategy

1. Create `strategies/my-strategy.ts` exporting a `Strategy` object
2. Import and add it to the `STRATEGIES` array in `strategies/index.ts`
3. Set `enabled: true` when ready to go live

See existing strategies for reference on filter values and exit rules.

---

## Filter Parameters

| Parameter | Description |
|---|---|
| `minMcUsd` / `maxMcUsd` | Market cap range in USD |
| `minVolume24h` | Minimum 24h trading volume |
| `minLiquidityUsd` | Minimum pool liquidity |
| `maxTopHolderPct` | Max % held by single wallet (rug protection) |
| `minHolderCount` | Minimum unique holders |
| `maxAgeHours` | Maximum token age in hours |
| `minRugcheckScore` | Minimum rugcheck.xyz score (0–100) |

## Exit Rules

| Parameter | Description |
|---|---|
| `stopLossPct` | Close if position value drops by this % |
| `takeProfitPct` | Close if position value rises by this % |
| `outOfRangeMinutes` | Close if out of range for this many minutes |
| `maxDurationHours` | Hard time limit regardless of performance |
| `claimFeesBeforeClose` | Whether to claim fees before closing |
| `minFeesToClaim` | Minimum SOL fees before triggering a claim |
