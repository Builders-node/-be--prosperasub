-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626015956 · food_provider_residences

create table if not exists public.food_provider_residences (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.food_providers(id) on delete cascade,
  residence_id uuid not null references public.food_residences(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (provider_id, residence_id)
);
create index if not exists idx_food_provider_residences_provider
  on public.food_provider_residences (provider_id);

alter table public.food_provider_residences enable row level security;
drop policy if exists food_provider_residences_all on public.food_provider_residences;
create policy food_provider_residences_all on public.food_provider_residences
  for all to public using (true) with check (true);
