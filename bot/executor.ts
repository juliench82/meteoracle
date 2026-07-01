/**
 * bot/executor.ts
 *
 * Thin orchestrator / barrel file.
 * Real implementation lives in ./executor/ submodules for maintainability.
 */

export { openPosition } from './executor/open';
export { closePosition, claimFeesForPosition } from './executor/close';
export { addLiquidityToPosition } from './executor/add-liquidity';

