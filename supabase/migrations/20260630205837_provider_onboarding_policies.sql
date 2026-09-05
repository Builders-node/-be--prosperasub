-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260630205837 · provider_onboarding_policies

drop policy if exists provider_applications_all on public.provider_applications;
create policy provider_applications_all on public.provider_applications for all to public using (true) with check (true);
drop policy if exists provider_accounts_all on public.provider_accounts;
create policy provider_accounts_all on public.provider_accounts for all to public using (true) with check (true);
