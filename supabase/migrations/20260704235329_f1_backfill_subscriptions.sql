-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704235329 · f1_backfill_subscriptions


-- Apply the same safe UUID coercion for user_id across ALL legacy services
-- (food/beach/massage store user_id as text — google-sub or uuid).

INSERT INTO public.provider_subscriptions (
  provider_id, plan_id, user_id, start_date, end_date, status, payment_status,
  payment_method, payment_reference, price_cents, metadata,
  source_service_key, source_subscription_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='cleaning' AND source_provider_id = s.provider_id),
  (SELECT id FROM public.provider_plans WHERE source_service_key='cleaning' AND source_plan_id = s.package_id),
  CASE WHEN s.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN s.user_id::uuid ELSE NULL END,
  s.service_start_date, s.service_end_date,
  COALESCE(s.subscription_status, 'pending'),
  COALESCE(s.payment_status, 'pending'),
  s.payment_method, s.payment_reference,
  COALESCE(s.total_price_cents, s.monthly_price_cents),
  '{}'::jsonb,
  'cleaning', s.id
FROM public.cleaning_subscriptions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_subscriptions x
  WHERE x.source_service_key='cleaning' AND x.source_subscription_id = s.id
);

INSERT INTO public.provider_subscriptions (
  provider_id, plan_id, user_id, start_date, end_date, status, payment_status,
  payment_method, payment_reference, price_cents, metadata,
  source_service_key, source_subscription_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='food' AND source_provider_id = s.provider_id),
  (SELECT id FROM public.provider_plans WHERE source_service_key='food' AND source_plan_id = s.meal_plan_id::text),
  CASE WHEN s.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN s.user_id::uuid ELSE NULL END,
  s.started_at, s.end_date,
  COALESCE(s.status, 'pending'),
  COALESCE(s.payment_status, 'pending'),
  s.payment_method, s.payment_reference, s.weekly_price_cents,
  '{}'::jsonb,
  'food', s.id::text
FROM public.food_subscriptions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_subscriptions x
  WHERE x.source_service_key='food' AND x.source_subscription_id = s.id::text
);

INSERT INTO public.provider_subscriptions (
  provider_id, plan_id, user_id, start_date, end_date, status, payment_status,
  payment_method, payment_reference, price_cents, metadata,
  source_service_key, source_subscription_id
)
SELECT
  '00000000-0000-0000-0000-000000beac41',
  (SELECT id FROM public.provider_plans WHERE source_service_key='beach' AND source_plan_id = s.plan_id::text),
  CASE WHEN s.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN s.user_id::uuid ELSE NULL END,
  s.start_date, s.end_date,
  COALESCE(s.status, 'pending'),
  COALESCE(s.payment_status, 'pending'),
  s.payment_method, s.payment_reference, s.total_cents,
  jsonb_build_object('people', s.people),
  'beach', s.id::text
FROM public.beach_club_subscriptions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_subscriptions x
  WHERE x.source_service_key='beach' AND x.source_subscription_id = s.id::text
);

INSERT INTO public.provider_subscriptions (
  provider_id, plan_id, user_id, start_date, end_date, status, payment_status,
  payment_method, payment_reference, price_cents, metadata,
  source_service_key, source_subscription_id
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='massage' AND source_provider_id = s.provider_id),
  (SELECT id FROM public.provider_plans WHERE source_service_key='massage' AND source_plan_id = s.plan_id::text),
  CASE WHEN s.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN s.user_id::uuid ELSE NULL END,
  s.started_at, s.end_date,
  COALESCE(s.status, 'pending'),
  COALESCE(s.payment_status, 'pending'),
  s.payment_method, s.payment_reference, s.price_cents,
  jsonb_build_object(
    'commitment_weeks', s.commitment_weeks,
    'sessions_total',   s.sessions_total,
    'sessions_used',    s.sessions_used
  ),
  'massage', s.id::text
FROM public.massage_subscriptions s
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_subscriptions x
  WHERE x.source_service_key='massage' AND x.source_subscription_id = s.id::text
);
