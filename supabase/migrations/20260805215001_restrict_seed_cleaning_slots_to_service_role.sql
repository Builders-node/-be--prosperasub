-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260805215001 · restrict_seed_cleaning_slots_to_service_role

-- Postgres grants EXECUTE on a new function to PUBLIC by default, so the
-- earlier `grant ... to service_role` narrowed nothing: the browser's anon key
-- could call this and insert hundreds of rows. Revoke first, then grant.
revoke execute on function public.seed_cleaning_slots(integer) from public;
revoke execute on function public.seed_cleaning_slots(integer) from anon;
revoke execute on function public.seed_cleaning_slots(integer) from authenticated;
grant execute on function public.seed_cleaning_slots(integer) to service_role;
