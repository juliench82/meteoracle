-- P2 Optional Schema Hardening
-- Run this migration only when your Supabase instance is healthy.
-- These columns move frequently-used values out of the metadata JSONB blob
-- for better query performance and analytics.
--
-- All columns are nullable and have IF NOT EXISTS guards.
-- The application continues to work even if you never run this migration.

-- lp_positions improvements
ALTER TABLE public.lp_positions
  ADD COLUMN IF NOT EXISTS pnl_pct numeric;

ALTER TABLE public.lp_positions
  ADD COLUMN IF NOT EXISTS total_fee_earned_usd numeric;

ALTER TABLE public.lp_positions
  ADD COLUMN IF NOT EXISTS sol_price_usd_at_close numeric;

-- Helpful indexes for common dashboard / monitoring queries
CREATE INDEX IF NOT EXISTS idx_lp_positions_status_closed_at
  ON public.lp_positions (status, closed_at DESC)
  WHERE status = 'closed';

CREATE INDEX IF NOT EXISTS idx_lp_positions_strategy_status_opened
  ON public.lp_positions (strategy_id, status, opened_at DESC);

-- Optional: add comment for future maintainers
COMMENT ON COLUMN public.lp_positions.pnl_pct IS 'P2: denormalized PnL % for faster filtering and reporting (also stored in metadata)';
COMMENT ON COLUMN public.lp_positions.total_fee_earned_usd IS 'P2: total fees earned on this position (especially useful for DAMM v2)';
COMMENT ON COLUMN public.lp_positions.sol_price_usd_at_close IS 'P2: SOL/USD price captured at close time for accurate historical PnL';