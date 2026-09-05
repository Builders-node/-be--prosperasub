-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804200701 · add_image_url_to_service_categories

-- Cover photo per category. Discovery tiles show up to two of them side by
-- side, so a service reads as "Apartment Cleaning + Car Wash" at a glance
-- rather than as two lines of text.
alter table public.service_categories
  add column if not exists image_url text;

comment on column public.service_categories.image_url is
  'Cover photo shown on the Discovery service tile. At most two per service are rendered — see MAX_TILE_IMAGES in pages/Discovery.tsx.';
