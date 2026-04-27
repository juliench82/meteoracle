-- Migration: observability improvements
-- 1. score_breakdown JSONB on candidates
-- 2. launchpad_source TEXT on candidates

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS score_breakdown   JSONB,
  ADD COLUMN IF NOT EXISTS launchpad_source  TEXT;

-- Backfill score_breakdown from existing numeric sub-score columns where available
UPDATE candidates
SET score_breakdown = jsonb_build_object(
  'score_volmc',       score_volmc,
  'score_holders',     score_holders,
  'score_freshness',   score_freshness,
  'launchpad_bonus',   score_curve_bonus,
  'final_score',       score
)
WHERE score_breakdown IS NULL
  AND score IS NOT NULL;

COMMENT ON COLUMN candidates.score_breakdown IS
  'Full scorer breakdown: {score_volmc, score_holders, score_freshness, launchpad_bonus, final_score}';

COMMENT ON COLUMN candidates.launchpad_source IS
  'Origin launchpad: pumpfun | moonshot | meteora | null';
