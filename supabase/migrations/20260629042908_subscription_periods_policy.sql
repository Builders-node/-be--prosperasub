-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260629042908 · subscription_periods_policy

drop policy if exists subscription_periods_all on public.subscription_periods;
create policy subscription_periods_all on public.subscription_periods for all to public using (true) with check (true);
