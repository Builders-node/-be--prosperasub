-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260903170149 · subscriptions_unified_includes_universal

-- The read model claimed to fold "every subscription" and was missing a whole
-- population: rows on universal-only services (source_service_key IS NULL) —
-- which is every new archetype and every one-time offer. The admin dashboard
-- reads this view for its approval queue, so those sales were invisible to
-- the person who approves them. Fourth arm, service = 'plan'.
CREATE OR REPLACE VIEW public.subscriptions_unified AS
 WITH today AS (
         SELECT (now() AT TIME ZONE 'America/Tegucigalpa'::text)::date AS d
        )
 SELECT 'cleaning'::text AS service,
    c.id,
    pkg.owner_provider_id AS provider_id,
    c.package_id AS plan_id,
    c.user_id,
    COALESCE(c.total_price_cents, c.monthly_price_cents, 0)::bigint AS price_cents,
    c.payment_status = 'paid'::text AS paid,
        CASE
            WHEN lower(COALESCE(c.subscription_status, ''::text)) <> 'active'::text THEN COALESCE(NULLIF(lower(c.subscription_status), ''::text), 'cancelled'::text)
            WHEN COALESCE(c.service_end_date, c.end_date, c.paid_until) < (( SELECT today.d FROM today)) THEN 'expired'::text
            ELSE 'active'::text
        END AS status,
    c.payment_status,
    c.created_at,
    COALESCE(c.service_start_date, c.start_date) AS starts_on,
    COALESCE(c.service_end_date, c.end_date) AS ends_on,
    NULL::text AS location
   FROM cleaning_subscriptions c
     LEFT JOIN cleaning_packages pkg ON pkg.id = c.package_id
  WHERE c.deleted_at IS NULL
UNION ALL
 SELECT 'food'::text AS service,
    f.id::text AS id,
    pr.id AS provider_id,
    f.meal_plan_id::text AS plan_id,
    f.user_id,
    (COALESCE(f.weekly_price_cents, 0) * GREATEST(COALESCE(f.commitment_weeks, 1), 1) * GREATEST(COALESCE(f.periods_paid, 1), 1))::bigint AS price_cents,
    f.payment_status = 'paid'::text AS paid,
        CASE
            WHEN lower(COALESCE(f.status, ''::text)) <> 'active'::text THEN COALESCE(NULLIF(lower(f.status), ''::text), 'pending'::text)
            WHEN f.end_date < (( SELECT today.d FROM today)) THEN 'expired'::text
            ELSE 'active'::text
        END AS status,
    f.payment_status,
    f.created_at,
    f.started_at AS starts_on,
    f.end_date AS ends_on,
    NULLIF(btrim(f.residence), ''::text) AS location
   FROM food_subscriptions f
     LEFT JOIN providers pr ON pr.source_service_key = 'food'::text AND pr.source_provider_id::text = f.provider_id::text
UNION ALL
 SELECT 'beach'::text AS service,
    b.id::text AS id,
    b.provider_id,
    b.plan_id::text AS plan_id,
    b.user_id::text AS user_id,
    COALESCE(b.price_cents, 0)::bigint AS price_cents,
    b.payment_status = 'paid'::text AS paid,
        CASE
            WHEN lower(COALESCE(b.status, ''::text)) <> 'active'::text THEN COALESCE(NULLIF(lower(b.status), ''::text), 'cancelled'::text)
            WHEN b.end_date < (( SELECT today.d FROM today)) THEN 'expired'::text
            ELSE 'active'::text
        END AS status,
    b.payment_status,
    b.created_at,
    b.start_date AS starts_on,
    b.end_date AS ends_on,
    NULL::text AS location
   FROM provider_subscriptions b
  WHERE b.source_service_key = 'beach'::text
UNION ALL
 SELECT 'plan'::text AS service,
    u.id::text AS id,
    u.provider_id,
    u.plan_id::text AS plan_id,
    u.user_id::text AS user_id,
    COALESCE(u.price_cents, 0)::bigint AS price_cents,
    u.payment_status = 'paid'::text AS paid,
        CASE
            WHEN lower(COALESCE(u.status, ''::text)) <> 'active'::text THEN COALESCE(NULLIF(lower(u.status), ''::text), 'cancelled'::text)
            WHEN u.end_date < (( SELECT today.d FROM today)) THEN 'expired'::text
            ELSE 'active'::text
        END AS status,
    u.payment_status,
    u.created_at,
    u.start_date AS starts_on,
    u.end_date AS ends_on,
    u.service_address AS location
   FROM provider_subscriptions u
  WHERE u.source_service_key IS NULL;
