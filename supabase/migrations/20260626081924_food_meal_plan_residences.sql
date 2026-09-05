-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626081924 · food_meal_plan_residences

create table if not exists public.food_meal_plan_residences (
  id uuid primary key default gen_random_uuid(),
  meal_plan_id uuid not null references public.food_meal_plans(id) on delete cascade,
  residence_id uuid not null references public.food_residences(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (meal_plan_id, residence_id)
);
create index if not exists idx_food_meal_plan_residences_plan
  on public.food_meal_plan_residences (meal_plan_id);

alter table public.food_meal_plan_residences enable row level security;
drop policy if exists food_meal_plan_residences_all on public.food_meal_plan_residences;
create policy food_meal_plan_residences_all on public.food_meal_plan_residences
  for all to public using (true) with check (true);
