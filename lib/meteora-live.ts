// Live Meteora syncing removed in ultra-simplified model (local-state only)
export type MeteoraLiveSourceStatus = any;
export type LiveMeteoraPosition = any;

export const fetchLiveMeteoraSnapshot = async () => ({ positions: [], status: 'stub' });
export const mergeDbAndLiveLpPositions = () => [];
export const syncAllMeteoraPositions = async () => {};
export const rebalanceDlmmPosition = async () => null;
export const fetchWalletLiveBalances = async () => ({});
export const detectAllOrphanedPositions = async () => [];
