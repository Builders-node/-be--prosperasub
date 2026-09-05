-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704235157 · f1_backfill_plans


INSERT INTO public.provider_plans (
  provider_id, name, description, price_cents, currency, period, features,
  status, sort_order, source_service_key, source_plan_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='cleaning' AND source_provider_id = pk.provider_id),
  pk.name, pk.description,
  COALESCE(pk.monthly_price_cents, pk.price_per_cleaning_cents, 0),
  'USD',
  CASE WHEN pk.monthly_price_cents IS NOT NULL THEN 'monthly' ELSE 'one_time' END,
  jsonb_build_object(
    'cleanings_per_month', pk.cleanings_per_month,
    'frequency_unit',      pk.frequency_unit,
    'frequency_count',     pk.frequency_count,
    'price_per_cleaning_cents', pk.price_per_cleaning_cents,
    'features_source', pk.features
  ),
  pk.status, pk.sort_order, 'cleaning', pk.id
FROM public.cleaning_packages pk
WHERE pk.deleted_at IS NULL
  AND pk.provider_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.provider_plans x
    WHERE x.source_service_key='cleaning' AND x.source_plan_id = pk.id
  );

INSERT INTO public.provider_plans (
  provider_id, name, description, price_cents, currency, period, features,
  status, source_service_key, source_plan_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='food' AND source_provider_id = mp.provider_id),
  mp.name, mp.description, mp.weekly_price_cents, 'USD', 'weekly',
  jsonb_build_object(
    'meals_per_day',  mp.meals_per_day,
    'meals_per_week', mp.meals_per_week,
    'days_per_week',  mp.days_per_week,
    'highlights',     mp.highlights
  ),
  mp.status, 'food', mp.id::text
FROM public.food_meal_plans mp
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_plans x
  WHERE x.source_service_key='food' AND x.source_plan_id = mp.id::text
);

INSERT INTO public.provider_plans (
  provider_id, name, description, price_cents, currency, period, features,
  status, sort_order, source_service_key, source_plan_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='massage' AND source_provider_id = mp.provider_id),
  mp.name, mp.description, mp.price_cents, 'USD',
  CASE WHEN mp.sessions_per_period IS NOT NULL AND mp.sessions_per_period > 1 THEN 'monthly' ELSE 'one_time' END,
  jsonb_build_object(
    'duration_minutes',    mp.duration_minutes,
    'sessions_per_period', mp.sessions_per_period,
    'highlights',          mp.highlights
  ),
  mp.status, mp.sort_order, 'massage', mp.id::text
FROM public.massage_plans mp
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_plans x
  WHERE x.source_service_key='massage' AND x.source_plan_id = mp.id::text
);

INSERT INTO public.provider_plans (
  provider_id, name, description, price_cents, currency, period, features,
  status, sort_order, source_service_key, source_plan_id
)
SELECT
  '00000000-0000-0000-0000-000000beac41',
  bp.name, bp.tagline, bp.price_per_person_cents, 'USD', 'monthly',
  jsonb_build_object(
    'amenities',                       bp.amenities,
    'featured',                        bp.featured,
    'provider_price_per_person_cents', bp.provider_price_per_person_cents,
    'extra_per_person_cents',          bp.extra_per_person_cents,
    'pricing_unit',                    'per_person'
  ),
  CASE WHEN bp.is_active THEN 'active' ELSE 'inactive' END,
  bp.sort_order, 'beach', bp.id::text
FROM public.beach_club_plans bp
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_plans x
  WHERE x.source_service_key='beach' AND x.source_plan_id = bp.id::text
);
