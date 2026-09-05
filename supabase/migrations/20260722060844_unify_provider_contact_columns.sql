-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260722060844 · unify_provider_contact_columns

-- Bring the 4 provider tables to a shared column set so the admin edit modals
-- can render an identical form for every service. Missing columns before:
--   cleaning_providers, food_providers → no contact_phone, contact_email
--   rental_providers                   → no location, working_hours, avatar_url, banner_url
-- Columns already on `providers` (universal) are the canonical shape.

ALTER TABLE public.cleaning_providers ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE public.cleaning_providers ADD COLUMN IF NOT EXISTS contact_email text;

ALTER TABLE public.food_providers ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE public.food_providers ADD COLUMN IF NOT EXISTS contact_email text;

ALTER TABLE public.rental_providers ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.rental_providers ADD COLUMN IF NOT EXISTS working_hours text;
-- Alias for logo_url so the shared modal can bind to a single "avatar" field
-- across services. logo_url stays populated for back-compat with any reader
-- that still references it.
ALTER TABLE public.rental_providers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.rental_providers ADD COLUMN IF NOT EXISTS banner_url text;

-- Backfill: seed avatar_url from logo_url wherever a logo exists but avatar is null.
UPDATE public.rental_providers
   SET avatar_url = logo_url
 WHERE avatar_url IS NULL AND logo_url IS NOT NULL;
