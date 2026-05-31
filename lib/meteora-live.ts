// Stubs for live Meteora syncing (removed in simplified stack)
export type MeteoraLiveSourceStatus = any;
export type LiveMeteoraPosition = any;

export async function fetchLiveMeteoraSnapshot() {
  console.warn('[meteora-live] fetchLiveMeteoraSnapshot is stubbed');
  return { positions: [], status: 'stub' };
}

export function mergeDbAndLiveLpPositions() {
  return [];
}

// Extra exports some restored code expects
export const syncAllMeteoraPositions = async () => {};
export const rebalanceDlmmPosition = async () => null;
export const fetchWalletLiveBalances = async () => ({});
export const detectAllOrphanedPositions = async () => [];
