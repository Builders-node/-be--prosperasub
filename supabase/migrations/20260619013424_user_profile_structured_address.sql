-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260619013424 · user_profile_structured_address

alter table public.user_profiles
  add column if not exists address_street text,
  add column if not exists address_house text,
  add column if not exists address_apartment text,
  add column if not exists address_area text,
  add column if not exists address_notes text;
