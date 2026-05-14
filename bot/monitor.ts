import { monitorPositions as coreMonitor, DAMM_EDGE_EXIT_STRATEGY, LIVE_CACHE_EXIT_STRATEGY_ID, checkDammEdgePosition, checkDlmmPosition } from './monitor-core'
import { checkDammEdgePosition as dammCheck } from './monitor-damm'
import { checkDlmmPosition as dlmmCheck } from './monitor-dlmm'

// Thin wrapper — all logic preserved in split files. No loss.

export { monitorPositions } from './monitor-core'
export { DAMM_EDGE_EXIT_STRATEGY, LIVE_CACHE_EXIT_STRATEGY_ID } from './monitor-core'

// Re-export for backward compat
console.log('[monitor] split complete — using monitor-core + monitor-damm + monitor-dlmm')
