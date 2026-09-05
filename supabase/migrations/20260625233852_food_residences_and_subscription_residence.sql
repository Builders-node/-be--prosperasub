-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260625233852 · food_residences_and_subscription_residence

-- Lookup table of residences/communities (data-driven so new ones need no code change)
create table if not exists public.food_residences (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.food_residences enable row level security;
drop policy if exists food_residences_all on public.food_residences;
create policy food_residences_all on public.food_residences
  for all to public using (true) with check (true);

insert into public.food_residences (name, sort_order) values
  ('Pristine Bay', 1),
  ('Duna Residences', 2)
on conflict (name) do nothing;

-- Residence on each subscription (the community; delivery_address stays the apartment/unit)
alter table public.food_subscriptions
  add column if not exists residence text;
