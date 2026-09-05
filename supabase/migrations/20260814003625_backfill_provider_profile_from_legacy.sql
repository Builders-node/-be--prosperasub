-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814003625 · backfill_provider_profile_from_legacy

-- The universal provider row becomes the source of truth for a profile, so it
-- has to carry what the legacy row was carrying first. Only Elias Cuisine has
-- real imagery today (four gallery photos in food_providers) and it lives
-- there, so switching the public reads before this would blank the food
-- listing.
--
-- COALESCE in one direction only: a value already set on `providers` wins, so
-- re-running this can never overwrite an edit made after the move.

update providers p set
  avatar_url   = coalesce(p.avatar_url, f.avatar_url, f.image_url),
  banner_url   = coalesce(p.banner_url, f.banner_url),
  description  = coalesce(p.description, f.description),
  location     = coalesce(p.location, f.location),
  contact_phone = coalesce(p.contact_phone, f.contact_phone),
  contact_email = coalesce(p.contact_email, f.contact_email),
  working_hours = coalesce(
    p.working_hours,
    case when f.working_hours is null or btrim(f.working_hours) = '' then null
         else f.working_hours::jsonb end),
  gallery_urls = case
    when coalesce(jsonb_array_length(p.gallery_urls), 0) > 0 then p.gallery_urls
    else coalesce(f.gallery_urls, '[]'::jsonb) end,
  updated_at = now()
from food_providers f
where p.source_service_key = 'food' and p.source_provider_id = f.id;

update providers p set
  avatar_url   = coalesce(p.avatar_url, c.avatar_url),
  banner_url   = coalesce(p.banner_url, c.banner_url),
  description  = coalesce(p.description, c.description),
  location     = coalesce(p.location, c.location),
  contact_phone = coalesce(p.contact_phone, c.contact_phone),
  contact_email = coalesce(p.contact_email, c.contact_email),
  working_hours = coalesce(
    p.working_hours,
    case when c.working_hours is null or btrim(c.working_hours) = '' then null
         else c.working_hours::jsonb end),
  gallery_urls = case
    when coalesce(jsonb_array_length(p.gallery_urls), 0) > 0 then p.gallery_urls
    else coalesce(c.gallery_urls, '[]'::jsonb) end,
  updated_at = now()
from cleaning_providers c
where p.source_service_key = 'cleaning' and p.source_provider_id = c.id;
