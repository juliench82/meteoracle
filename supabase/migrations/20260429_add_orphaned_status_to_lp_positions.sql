-- Migration: 20260429131347_add_orphaned_status_to_lp_positions
-- Adds 'orphaned' as a valid status and token_address column to lp_positions.
-- Orphaned positions are on-chain DLMM positions that have no matching DB row.

-- 1. Drop existing status constraint and re-add with 'orphaned' included
ALTER TABLE lp_positions
  DROP CONSTRAINT IF EXISTS lp_positions_status_check;

ALTER TABLE lp_positions
  ADD CONSTRAINT lp_positions_status_check
  CHECK (status IN ('active', 'open', 'out_of_range', 'closed', 'pending_retry', 'pending_close', 'error', 'orphaned'));

-- 2. Add token_address column (nullable text; orphan-detector inserts '' as placeholder)
ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS token_address TEXT;
