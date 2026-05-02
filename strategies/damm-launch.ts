/**
 * strategies/damm-launch.ts - Isolated strategy for creating brand-new DAMM v2 pools
 * Triggers only on freshly graduated tokens (Pump.fun / Moonshot / Meteora new listings)
 */

import type { TokenMetrics } from '../lib/types';

export async function evaluateDammLaunch(metrics: TokenMetrics): Promise<boolean> {
  const ageMinutes = metrics.ageHours * 60;
  const launchMetrics = metrics as TokenMetrics & { feeTvlRatio1h?: number };
  const feeTvlRatio1h = launchMetrics.feeTvlRatio1h ?? ((metrics.feeTvl1hPct ?? 0) / 100);

  if (ageMinutes > 30) {
    console.log(`[scanner][damm-launch] REJECT ${metrics.symbol}: ${ageMinutes.toFixed(1)}min old (max 30min for pool creation)`);
    return false;
  }

  // Very strict momentum requirements for pool creation
  if (feeTvlRatio1h < 0.08) return false;   // high fee efficiency
  if ((metrics.volume1h || 0) < 15000) return false;

  console.log(`[scanner][damm-launch] PASS ${metrics.symbol} - creating new DAMM v2 pool`);
  return true;
}
