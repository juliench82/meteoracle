-- Migration: add scorer sub-score columns to candidates
-- Enables weight-tuning and PnL correlation analysis across runs
-- Note: score_rug intentionally omitted — rugcheck_score already stored;
--       score_rug is a lossy bucket of it, adding no analytical value.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS score_volmc        numeric,
  ADD COLUMN IF NOT EXISTS score_holders      numeric,
  ADD COLUMN IF NOT EXISTS score_freshness    numeric,
  ADD COLUMN IF NOT EXISTS score_curve_bonus  numeric;

COMMENT ON COLUMN candidates.score_volmc       IS 'Volume/MC sub-score (0-100), weight=0.40';
COMMENT ON COLUMN candidates.score_holders     IS 'Holder count sub-score (0-100), weight=0.20';
COMMENT ON COLUMN candidates.score_freshness   IS 'Freshness sub-score (0-100), weight=0.15';
COMMENT ON COLUMN candidates.score_curve_bonus IS 'Pump.fun bonding curve additive bonus (0, 4, 5, or 8)';
