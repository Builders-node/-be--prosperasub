-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816192715 · provider_membership_writes_service_role_only

-- Who runs a business is not a client-writable fact.
--
-- `provider_members` carried `FOR ALL TO public USING (true)`, and the backend
-- grants access to a provider's occurrences — home addresses, access
-- instructions — to anyone holding a row in it. The anon key ships in the
-- browser bundle, so one INSERT was enough. Reads stay public (the Team tab
-- and "My business" list them); writes now belong to the service role, behind
-- the owner check in ProviderMembersService.
drop policy if exists provider_members_all on public.provider_members;

create policy provider_members_read
  on public.provider_members for select
  to public using (true);
