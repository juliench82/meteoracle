create table if not exists public.bot_health (
  service text primary key,
  last_scan_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bot_health add column if not exists service text;
alter table public.bot_health add column if not exists last_scan_at timestamptz;
alter table public.bot_health add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.bot_health add column if not exists created_at timestamptz not null default now();
alter table public.bot_health add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_bot_health_updated_at on public.bot_health;
create trigger set_bot_health_updated_at
before update on public.bot_health
for each row execute function public.set_updated_at();
