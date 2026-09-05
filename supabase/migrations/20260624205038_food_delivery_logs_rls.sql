-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260624205038 · food_delivery_logs_rls

alter table public.food_delivery_logs enable row level security;

drop policy if exists food_delivery_logs_all on public.food_delivery_logs;
create policy food_delivery_logs_all
  on public.food_delivery_logs
  for all
  to public
  using (true)
  with check (true);
