-- moonboy_positions: tracks spot-buy positions opened by the moonboy strategy.
-- These are direct token purchases (not LP), exited via Jupiter swap.
create table if not exists moonboy_positions (
  id                uuid primary key default gen_random_uuid(),
  mint              text        not null,
  symbol            text        not null,
  entry_price_usd   numeric(20,10) not null default 0,
  current_price_usd numeric(20,10),
  token_amount      text        not null default '0',
  sol_spent         numeric(18,9) not null default 0,
  pnl_pct           numeric(10,4),
  status            text        not null default 'open',   -- open | closed | sell_failed
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  close_reason      text,
  tx_open           text,
  tx_close          text,
  strategy_id       text        not null default 'moonboy',
  dry_run           boolean     not null default false,
  sol_price_usd     numeric(10,2),
  metadata          jsonb
);

create index if not exists moonboy_positions_status_idx on moonboy_positions(status);
create index if not exists moonboy_positions_mint_idx   on moonboy_positions(mint);

comment on table moonboy_positions is
  'Spot-buy positions opened by moonboy strategy: buy $X of early token, sell at 2x or stop.';
