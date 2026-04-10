-- Migration 002: add entry_price_usd column to spot_positions
-- Run this in Supabase SQL editor before switching to live mode.

ALTER TABLE spot_positions
  ADD COLUMN IF NOT EXISTS entry_price_usd NUMERIC DEFAULT 0;

COMMENT ON COLUMN spot_positions.entry_price_usd IS
  'USD price at time of entry (Jupiter Price API). Used by spot-monitor for live % change calculation.';
