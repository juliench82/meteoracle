-- Add updated_at to positions so monitor can track OOR duration accurately

alter table positions
  add column if not exists updated_at timestamptz not null default now();

-- Auto-update updated_at on row change
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists positions_updated_at on positions;
create trigger positions_updated_at
  before update on positions
  for each row execute function update_updated_at();

-- Index for monitor query (active + out_of_range)
create index if not exists positions_status_updated
  on positions (status, updated_at)
  where status in ('active', 'out_of_range');
