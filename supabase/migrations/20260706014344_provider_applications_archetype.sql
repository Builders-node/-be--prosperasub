-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706014344 · provider_applications_archetype

alter table public.provider_applications
  add column if not exists archetype_key text references public.service_archetypes(key);
create index if not exists provider_applications_archetype_idx on public.provider_applications (archetype_key);
