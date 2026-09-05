-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626081047 · user_locations_residence

alter table public.user_locations add column if not exists residence text;
