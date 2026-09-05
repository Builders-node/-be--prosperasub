-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260903182531 · subscriptions_unified_sales_columns

-- Extend subscriptions_unified so the admin Subscriptions page can read it
-- instead of three legacy tables (which missed cars + universal/one-time
-- sales entirely). Appended columns only — CREATE OR REPLACE keeps positions.
CREATE OR REPLACE VIEW public.subscriptions_unified AS
WITH today AS (
  SELECT (now() AT TIME ZONE 'America/Tegucigalpa')::date AS d
)
SELECT 'cleaning'::text AS service,
  c.id,
  pkg.owner_provider_id AS provider_id,
  c.package_id AS plan_id,
  c.user_id,
  COALESCE(c.total_price_cents, c.monthly_price_cents, 0)::bigint AS price_cents,
  c.payment_status = 'paid' AS paid,
  CASE
    WHEN lower(COALESCE(c.subscription_status, '')) <> 'active' THEN COALESCE(NULLIF(lower(c.subscription_status), ''), 'cancelled')
    WHEN COALESCE(c.service_end_date, c.end_date, c.paid_until) < (SELECT d FROM today) THEN 'expired'
    ELSE 'active'
  END AS status,
  c.payment_status,
  c.created_at,
  COALESCE(c.service_start_date, c.start_date) AS starts_on,
  COALESCE(c.service_end_date, c.end_date) AS ends_on,
  NULL::text AS location,
  c.payment_method,
  c.payment_reference,
  COALESCE(NULLIF(cc.company_name, ''), NULLIF(cc.contact_person, '')) AS customer_name,
  pkg.name AS plan_name,
  'subscription'::text AS kind
FROM cleaning_subscriptions c
LEFT JOIN cleaning_packages pkg ON pkg.id = c.package_id
LEFT JOIN cleaning_clients cc ON cc.id = c.client_id
WHERE c.deleted_at IS NULL
UNION ALL
SELECT 'food',
  f.id::text,
  pr.id,
  f.meal_plan_id::text,
  f.user_id,
  (COALESCE(f.weekly_price_cents, 0) * GREATEST(COALESCE(f.commitment_weeks, 1), 1) * GREATEST(COALESCE(f.periods_paid, 1), 1))::bigint,
  f.payment_status = 'paid',
  CASE
    WHEN lower(COALESCE(f.status, '')) <> 'active' THEN COALESCE(NULLIF(lower(f.status), ''), 'pending')
    WHEN f.end_date < (SELECT d FROM today) THEN 'expired'
    ELSE 'active'
  END,
  f.payment_status,
  f.created_at,
  f.started_at,
  f.end_date,
  NULLIF(btrim(f.residence), ''),
  f.payment_method,
  f.payment_reference,
  NULLIF(f.customer_name, ''),
  mp.name,
  'subscription'
FROM food_subscriptions f
LEFT JOIN providers pr ON pr.source_service_key = 'food' AND pr.source_provider_id::text = f.provider_id::text
LEFT JOIN food_meal_plans mp ON mp.id = f.meal_plan_id
UNION ALL
SELECT 'beach',
  b.id::text,
  b.provider_id,
  b.plan_id::text,
  b.user_id::text,
  COALESCE(b.price_cents, 0)::bigint,
  b.payment_status = 'paid',
  CASE
    WHEN lower(COALESCE(b.status, '')) <> 'active' THEN COALESCE(NULLIF(lower(b.status), ''), 'cancelled')
    WHEN b.end_date < (SELECT d FROM today) THEN 'expired'
    ELSE 'active'
  END,
  b.payment_status,
  b.created_at,
  b.start_date,
  b.end_date,
  NULL::text,
  b.payment_method,
  b.payment_reference,
  NULLIF(b.metadata->>'customer_name', ''),
  COALESCE(NULLIF(b.metadata->>'plan_name', ''), bp.name),
  'subscription'
FROM provider_subscriptions b
LEFT JOIN provider_plans bp ON bp.id = b.plan_id
WHERE b.source_service_key = 'beach'
UNION ALL
SELECT 'plan',
  u.id::text,
  u.provider_id,
  u.plan_id::text,
  u.user_id::text,
  COALESCE(u.price_cents, 0)::bigint,
  u.payment_status = 'paid',
  CASE
    WHEN lower(COALESCE(u.status, '')) <> 'active' THEN COALESCE(NULLIF(lower(u.status), ''), 'cancelled')
    WHEN u.end_date < (SELECT d FROM today) THEN 'expired'
    ELSE 'active'
  END,
  u.payment_status,
  u.created_at,
  u.start_date,
  u.end_date,
  u.service_address,
  u.payment_method,
  u.payment_reference,
  NULLIF(u.metadata->>'customer_name', ''),
  COALESCE(NULLIF(u.metadata->>'plan_name', ''), up.name),
  'subscription'
FROM provider_subscriptions u
LEFT JOIN provider_plans up ON up.id = u.plan_id
WHERE u.source_service_key IS NULL
UNION ALL
SELECT 'cars',
  r.id::text,
  r.provider_id,
  r.vehicle_id::text,
  r.user_id,
  COALESCE(r.total_cents, 0)::bigint,
  r.payment_status = 'paid',
  CASE
    WHEN lower(COALESCE(r.status, '')) = 'cancelled' THEN 'cancelled'
    WHEN lower(COALESCE(r.status, '')) = 'completed' THEN 'expired'
    WHEN r.end_date < (SELECT d FROM today) THEN 'expired'
    WHEN lower(COALESCE(r.status, '')) = ANY (ARRAY['confirmed','active','paid']) THEN 'active'
    ELSE COALESCE(NULLIF(lower(r.status), ''), 'pending')
  END,
  r.payment_status,
  r.created_at,
  r.start_date,
  r.end_date,
  NULL::text,
  r.payment_method,
  r.payment_reference,
  NULLIF(r.customer_name, ''),
  v.name,
  'booking'
FROM rental_bookings r
LEFT JOIN rental_vehicles v ON v.id = r.vehicle_id
WHERE r.deleted_at IS NULL;

COMMENT ON VIEW public.subscriptions_unified IS
'One row per sale across every service (cleaning, food, beach, plan = universal-only, cars = rental bookings). Effective status computed in Honduras time. price_cents is the full committed BASE value (no surcharge, no deposit). Now also carries payment_method/reference, customer_name, plan_name and kind so admin list pages need no per-table adapters. Writes still go to the underlying tables.';
