import { monitorPositions } from './monitor-core'

// Thin wrapper — all logic preserved in split files. No loss.
export { monitorPositions }
export { DAMM_EDGE_EXIT_STRATEGY, LIVE_CACHE_EXIT_STRATEGY_ID } from './monitor-core'

console.log('[monitor] split complete — using monitor-core + monitor-damm + monitor-dlmm')
