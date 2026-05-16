/**
 * bot/executor.ts
 *
 * Thin orchestrator / barrel file.
 * Real implementation lives in ./executor/ submodules for maintainability.
 */

export { openPosition } from './executor/open';
export { closePosition } from './executor/close';
export { addLiquidityToPosition } from './executor/add-liquidity';

// Re-export Moonboy for convenience
export { openMoonboyPosition } from './moonboy-executor'




