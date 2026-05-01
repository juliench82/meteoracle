-- Migration 002: create/align spot_positions
-- The dashboard still reads spot history, and later migrations reference this
-- table from lp_positions. Keep this migration self-contained so a fresh
-- database can apply the full migration directory in order.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS spot_positions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  mint            text NOT NULL,
  symbol          text NOT NULL DEFAULT 'UNKNOWN',
  name            text,
  amount_sol      numeric NOT NULL DEFAULT 0,
  token_amount    numeric NOT NULL DEFAULT 0,
  entry_price_usd numeric NOT NULL DEFAULT 0,
  entry_price_sol numeric NOT NULL DEFAULT 0,
  current_price_usd numeric,
  tp_pct          numeric NOT NULL DEFAULT 0,
  sl_pct          numeric NOT NULL DEFAULT 0,
  pnl_sol         numeric,
  pnl_pct         numeric,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN (
                      'open',
                      'closed_tp',
                      'closed_sl',
                      'closed_manual',
                      'closed_timeout',
                      'emergency_stop'
                    )),
  dry_run         boolean NOT NULL DEFAULT true,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  tx_buy          text,
  tx_sell         text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE spot_positions
  ADD COLUMN IF NOT EXISTS entry_price_usd NUMERIC DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_spot_positions_status_opened
  ON spot_positions (status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_spot_positions_mint
  ON spot_positions (mint);

COMMENT ON COLUMN spot_positions.entry_price_usd IS
  'USD price at time of entry (Jupiter Price API). Used by spot-monitor for live % change calculation.';
