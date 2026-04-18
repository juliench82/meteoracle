-- 005_lp_positions_monitor_cols.sql
-- Columns written by lp-monitor-dlmm on every tick.

alter table lp_positions
  add column if not exists current_price   numeric,
  add column if not exists il_pct          numeric,
  add column if not exists entry_price_sol numeric not null default 0,
  add column if not exists strategy_id     text;
