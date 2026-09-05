-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626213355 · massage_rls

do $$
declare t text;
begin
  foreach t in array array['massage_providers','massage_plans','massage_subscriptions','massage_slots','massage_bookings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_all', t);
    execute format('create policy %I on public.%I for all to public using (true) with check (true)', t||'_all', t);
  end loop;
end $$;
