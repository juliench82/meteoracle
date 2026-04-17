-- Migration: add token_class and strategy_id columns
-- 2026-04-17

-- candidates table
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS token_class  TEXT,
  ADD COLUMN IF NOT EXISTS strategy_id  TEXT;

-- lp_positions table
ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS token_class  TEXT,
  ADD COLUMN IF NOT EXISTS strategy_id  TEXT;

-- index for dashboard queries by class
CREATE INDEX IF NOT EXISTS idx_lp_positions_token_class ON lp_positions (token_class);
CREATE INDEX IF NOT EXISTS idx_candidates_token_class   ON candidates   (token_class);
