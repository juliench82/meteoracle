-- 20260501_add_damm_pnl_columns.sql
-- Adds columns required by DAMM executor + live monitor (claimable_fees_usd, position_value_usd, realized_pnl_usd, position_type)

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS position_type          TEXT NOT NULL DEFAULT 'dlmm',
  ADD COLUMN IF NOT EXISTS claimable_fees_usd     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS position_value_usd     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS realized_pnl_usd       NUMERIC DEFAULT 0;

-- Make sure strategy_id exists (used heavily by DAMM)
ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS strategy_id            TEXT;

COMMENT ON COLUMN lp_positions.position_type IS 'dlmm or damm-edge';
