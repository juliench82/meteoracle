-- 004_pre_grad_watchlist_velocity.sql
-- Adds velocity tracking + dev wallet columns to pre_grad_watchlist.

alter table pre_grad_watchlist
  add column if not exists bonding_curve_pct         numeric,
  add column if not exists holder_count              integer,
  add column if not exists top_holder_pct            numeric,
  add column if not exists dev_wallet_pct            numeric,
  add column if not exists first_seen_at             timestamptz,
  add column if not exists bonding_pct_at_first_seen numeric,
  add column if not exists velocity_pct_per_min      numeric;

create index if not exists pre_grad_watchlist_bonding_pct_idx on pre_grad_watchlist (bonding_curve_pct);
