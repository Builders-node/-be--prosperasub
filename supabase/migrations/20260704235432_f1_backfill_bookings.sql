-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704235432 · f1_backfill_bookings


-- cleaning_bookings → provider_bookings
-- No provider_id on cleaning_bookings — link through the parent subscription.
INSERT INTO public.provider_bookings (
  provider_id, plan_id, user_id, status, metadata,
  source_service_key, source_booking_id, created_at, updated_at
)
SELECT
  COALESCE(
    (SELECT ps.provider_id FROM public.provider_subscriptions ps
      WHERE ps.source_service_key='cleaning'
        AND ps.source_subscription_id = COALESCE(b.cleaning_subscription_id::text, b.subscription_id::text)),
    (SELECT id FROM public.providers WHERE source_service_key='cleaning' AND is_platform_owned = true LIMIT 1)
  ),
  (SELECT ps.plan_id FROM public.provider_subscriptions ps
    WHERE ps.source_service_key='cleaning'
      AND ps.source_subscription_id = COALESCE(b.cleaning_subscription_id::text, b.subscription_id::text)),
  CASE WHEN b.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN b.user_id::uuid ELSE NULL END,
  COALESCE(b.status, 'pending'),
  jsonb_build_object(
    'slot_id',      b.slot_id,
    'notes',        b.notes,
    'subscription_source_id', COALESCE(b.cleaning_subscription_id::text, b.subscription_id::text)
  ),
  'cleaning', b.id, b.created_at, b.updated_at
FROM public.cleaning_bookings b
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_bookings x
  WHERE x.source_service_key='cleaning' AND x.source_booking_id = b.id
);

-- food_orders → provider_bookings (one-off food delivery)
INSERT INTO public.provider_bookings (
  provider_id, plan_id, user_id, status, payment_status, price_cents, metadata,
  source_service_key, source_booking_id, created_at, updated_at
)
SELECT
  (SELECT id FROM public.providers WHERE source_service_key='food' AND source_provider_id = o.provider_id),
  (SELECT id FROM public.provider_plans WHERE source_service_key='food' AND source_plan_id = o.meal_plan_id::text),
  CASE WHEN o.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN o.user_id::uuid ELSE NULL END,
  COALESCE(o.status, 'pending'), 'pending', o.total_cents,
  jsonb_build_object(
    'menu_id',          o.menu_id,
    'week_start_date',  o.week_start_date,
    'delivery_status',  o.delivery_status,
    'customer_name',    o.customer_name,
    'customer_whatsapp',o.customer_whatsapp,
    'delivery_address', o.delivery_address,
    'notes',            o.notes,
    'admin_notes',      o.admin_notes,
    'duration_weeks',   o.duration_weeks
  ),
  'food', o.id::text, o.created_at, o.updated_at
FROM public.food_orders o
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_bookings x
  WHERE x.source_service_key='food' AND x.source_booking_id = o.id::text
);
