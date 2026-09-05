-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812194404 · plan_option_tables_rls

-- Same posture as every other config table here, stated rather than inherited.
--
-- Without RLS enabled a table is simply open to the anon key, which is where
-- these two would have landed by default. The admin CRUDs write plan options
-- from the browser exactly as they write categories and archetypes, so the
-- policy is permissive — but it is now written down, and tightening it is one
-- ALTER away instead of a question about what the default was.
--
-- The money table (provider_payouts) is the deliberate exception: RLS on, no
-- policies, everything through NestJS.

alter table public.plan_option_groups enable row level security;
alter table public.plan_options       enable row level security;

drop policy if exists plan_option_groups_all on public.plan_option_groups;
create policy plan_option_groups_all on public.plan_option_groups
  for all to public using (true) with check (true);

drop policy if exists plan_options_all on public.plan_options;
create policy plan_options_all on public.plan_options
  for all to public using (true) with check (true);
