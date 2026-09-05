-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260610204204 · food_providers_restaurant_fields


ALTER TABLE public.food_providers
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT,
  ADD COLUMN IF NOT EXISTS banner_url   TEXT,
  ADD COLUMN IF NOT EXISTS working_hours TEXT,
  ADD COLUMN IF NOT EXISTS location     TEXT;

-- Seed update: fill new fields for the existing provider
UPDATE public.food_providers
SET
  working_hours = 'Mon–Fri 08:00–20:00',
  location      = 'Prospera Village, Main Kitchen Block'
WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
