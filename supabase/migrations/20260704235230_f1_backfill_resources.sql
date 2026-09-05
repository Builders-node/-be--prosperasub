-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704235230 · f1_backfill_resources


-- beach_club_courts → bookable_resources under the synthetic Beach Club provider
INSERT INTO public.bookable_resources (
  provider_id, name, type, hours, metadata, status, sort_order,
  source_service_key, source_resource_id
)
SELECT
  '00000000-0000-0000-0000-000000beac41',
  c.name, COALESCE(c.type, 'court'),
  jsonb_build_object(
    'open_hour',    c.open_hour,
    'close_hour',   c.close_hour,
    'slot_minutes', c.slot_minutes
  ),
  jsonb_build_object(
    'description',           c.description,
    'external_ics_url',      c.external_ics_url,
    'ical_feed_token',       c.ical_feed_token,
    'google_calendar_id',    c.google_calendar_id,
    'google_last_synced_at', c.google_last_synced_at
  ),
  CASE WHEN c.is_active THEN 'active' ELSE 'inactive' END,
  c.sort_order, 'beach', c.id::text
FROM public.beach_club_courts c
WHERE NOT EXISTS (
  SELECT 1 FROM public.bookable_resources x
  WHERE x.source_service_key='beach' AND x.source_resource_id = c.id::text
);

-- rental_vehicles → bookable_resources under the rental provider
INSERT INTO public.bookable_resources (
  provider_id, name, type, metadata, status, sort_order,
  source_service_key, source_resource_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='cars' AND source_provider_id = v.provider_id),
  v.name, 'vehicle',
  jsonb_build_object(
    'description',            v.description,
    'brand',                  v.brand,
    'model',                  v.model,
    'year',                   v.year,
    'seats',                  v.seats,
    'transmission',           v.transmission,
    'fuel_type',              v.fuel_type,
    'air_conditioning',       v.air_conditioning,
    'luggage_capacity',       v.luggage_capacity,
    'daily_price_cents',      v.daily_price_cents,
    'weekly_price_cents',     v.weekly_price_cents,
    'biweekly_price_cents',   v.biweekly_price_cents,
    'monthly_price_cents',    v.monthly_price_cents,
    'monthly_discount_pct',   v.monthly_discount_pct
  ),
  v.status, v.sort_order, 'cars', v.id::text
FROM public.rental_vehicles v
WHERE v.provider_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.bookable_resources x
    WHERE x.source_service_key='cars' AND x.source_resource_id = v.id::text
  );
