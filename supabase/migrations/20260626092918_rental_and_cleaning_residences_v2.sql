-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626092918 · rental_and_cleaning_residences_v2

create table if not exists public.rental_vehicle_residences (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.rental_vehicles(id) on delete cascade,
  residence_id uuid not null references public.food_residences(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (vehicle_id, residence_id)
);
create index if not exists idx_rental_vehicle_residences_vehicle on public.rental_vehicle_residences (vehicle_id);
alter table public.rental_vehicle_residences enable row level security;
drop policy if exists rental_vehicle_residences_all on public.rental_vehicle_residences;
create policy rental_vehicle_residences_all on public.rental_vehicle_residences for all to public using (true) with check (true);

create table if not exists public.cleaning_package_residences (
  id uuid primary key default gen_random_uuid(),
  package_id text not null,
  residence_id uuid not null references public.food_residences(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (package_id, residence_id)
);
create index if not exists idx_cleaning_package_residences_package on public.cleaning_package_residences (package_id);
alter table public.cleaning_package_residences enable row level security;
drop policy if exists cleaning_package_residences_all on public.cleaning_package_residences;
create policy cleaning_package_residences_all on public.cleaning_package_residences for all to public using (true) with check (true);
