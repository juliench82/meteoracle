alter table public.lp_positions
  add column if not exists null_pnl_ticks integer not null default 0;
