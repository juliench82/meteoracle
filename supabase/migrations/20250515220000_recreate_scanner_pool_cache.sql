-- Recreate scanner_pool_cache table (deleted by mistake)
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.scanner_pool_cache (
  pool_address text PRIMARY KEY,
  token_address text NOT NULL,
  symbol text,
  scanner_lane text DEFAULT 'meteora',
  pool_created_at timestamptz,
  age_minutes integer,
  liquidity_usd numeric,
  market_cap_usd numeric,
  volume_24h numeric,
  volume_1h numeric,
  volume_5m numeric,
  fee_tvl_24h_pct numeric,
  fee_tvl_1h_pct numeric,
  fee_tvl_5m_pct numeric,
  volume_spike_ratio numeric,
  momentum_score integer,
  is_blacklisted boolean DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for the cleanup query in loadDbPoolCache
CREATE INDEX IF NOT EXISTS idx_scanner_pool_cache_last_seen
  ON public.scanner_pool_cache (last_seen_at);

-- Optional but recommended: allow service_role full access (already the case by default)
-- No RLS policy needed for internal scanner use
