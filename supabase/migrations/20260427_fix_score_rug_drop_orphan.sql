-- Fix: add score_rug which was omitted from 20260426_add_score_breakdown.sql
-- Also drops score_breakdown (jsonb) — superseded by individual score_* columns,
-- never written by the scanner.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS score_rug numeric;

COMMENT ON COLUMN candidates.score_rug IS 'Rugcheck sub-score (0-100), weight=0.25';

ALTER TABLE candidates
  DROP COLUMN IF EXISTS score_breakdown;
