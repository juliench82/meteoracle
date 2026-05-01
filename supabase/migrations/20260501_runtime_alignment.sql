-- Runtime/schema alignment for the current DLMM + DAMM bot code.
-- Adds columns written by monitor, executor, orphan detector, and dashboard
-- views, then normalizes the lp_positions status constraint.

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS entry_price        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_price      numeric,
  ADD COLUMN IF NOT EXISTS il_pct             numeric,
  ADD COLUMN IF NOT EXISTS claimable_fees_usd numeric,
  ADD COLUMN IF NOT EXISTS position_value_usd numeric,
  ADD COLUMN IF NOT EXISTS realized_pnl_usd   numeric,
  ADD COLUMN IF NOT EXISTS position_type      text,
  ADD COLUMN IF NOT EXISTS token_address      text;

ALTER TABLE lp_positions
  DROP CONSTRAINT IF EXISTS lp_positions_status_check;

ALTER TABLE lp_positions
  ADD CONSTRAINT lp_positions_status_check
  CHECK (status IN (
    'active',
    'open',
    'dry_run',
    'out_of_range',
    'closed',
    'pending_retry',
    'pending_close',
    'error',
    'orphaned'
  ));

CREATE INDEX IF NOT EXISTS idx_lp_positions_strategy_status
  ON lp_positions (strategy_id, status);

CREATE INDEX IF NOT EXISTS idx_lp_positions_position_pubkey
  ON lp_positions (position_pubkey)
  WHERE position_pubkey IS NOT NULL AND position_pubkey <> 'DRY_RUN';

COMMENT ON COLUMN lp_positions.claimable_fees_usd IS
  'Live claimable fees snapshot from Meteora APIs.';

COMMENT ON COLUMN lp_positions.position_value_usd IS
  'Live open-position value snapshot from Meteora APIs.';

COMMENT ON COLUMN lp_positions.realized_pnl_usd IS
  'Close-time realized PnL snapshot from Meteora APIs when available.';
