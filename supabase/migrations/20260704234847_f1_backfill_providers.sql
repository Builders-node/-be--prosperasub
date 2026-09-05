-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704234847 · f1_backfill_providers


-- Cast text-typed admin_user_id (Google sub OR UUID) to uuid safely:
-- only when it matches the UUID pattern, else NULL. Idempotent NOT EXISTS.

INSERT INTO public.providers (
  category_key, name, description, avatar_url, banner_url, location,
  working_hours, status, sort_order, admin_user_id, is_platform_owned,
  capabilities, source_service_key, source_provider_id, created_at, updated_at
)
SELECT 'home', p.name, p.description, p.avatar_url, p.banner_url, p.location,
       p.working_hours, p.status, p.sort_order, p.admin_user_id,
       (p.name = 'ProsperaSub Cleaning'),
       ARRAY['subscription_plans']::text[],
       'cleaning', p.id, p.created_at, p.updated_at
FROM public.cleaning_providers p
WHERE NOT EXISTS (
  SELECT 1 FROM public.providers x
  WHERE x.source_service_key = 'cleaning' AND x.source_provider_id = p.id
);

INSERT INTO public.providers (
  category_key, name, description, avatar_url, banner_url, location,
  working_hours, status, sort_order, admin_user_id, is_platform_owned,
  capabilities, source_service_key, source_provider_id, created_at, updated_at
)
SELECT 'food', p.name, p.description, p.avatar_url, p.banner_url, p.location,
       p.working_hours, p.status, p.sort_order,
       CASE WHEN p.admin_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN p.admin_user_id::uuid ELSE NULL END,
       false,
       ARRAY['subscription_plans','catalog_items','delivery']::text[],
       'food', p.id, p.created_at, p.updated_at
FROM public.food_providers p
WHERE NOT EXISTS (
  SELECT 1 FROM public.providers x
  WHERE x.source_service_key = 'food' AND x.source_provider_id = p.id
);

INSERT INTO public.providers (
  category_key, name, description, avatar_url, contact_phone, contact_email,
  status, sort_order, admin_user_id, is_platform_owned,
  capabilities, source_service_key, source_provider_id, created_at, updated_at
)
SELECT 'transport', p.name, p.description, p.logo_url, p.contact_phone, p.contact_email,
       p.status, p.sort_order, p.admin_user_id, false,
       ARRAY['date_range_booking','catalog_items']::text[],
       'cars', p.id, p.created_at, p.updated_at
FROM public.rental_providers p
WHERE NOT EXISTS (
  SELECT 1 FROM public.providers x
  WHERE x.source_service_key = 'cars' AND x.source_provider_id = p.id
);

INSERT INTO public.providers (
  category_key, name, description, avatar_url, banner_url, location,
  working_hours, status, sort_order, admin_user_id, is_platform_owned,
  capabilities, source_service_key, source_provider_id, created_at, updated_at
)
SELECT 'wellness', p.name, p.description, p.avatar_url, p.banner_url, p.location,
       p.working_hours, p.status, p.sort_order,
       CASE WHEN p.admin_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN p.admin_user_id::uuid ELSE NULL END,
       false,
       ARRAY['subscription_plans','hourly_bookings']::text[],
       'massage', p.id, p.created_at, p.updated_at
FROM public.massage_providers p
WHERE NOT EXISTS (
  SELECT 1 FROM public.providers x
  WHERE x.source_service_key = 'massage' AND x.source_provider_id = p.id
);

INSERT INTO public.providers (
  id, category_key, name, description, status, sort_order,
  is_platform_owned, capabilities, source_service_key
)
SELECT '00000000-0000-0000-0000-000000beac41',
       'venues', 'Beach Club', 'ProsperaSub Beach Club — memberships and courts',
       'active', 0, true,
       ARRAY['subscription_plans','hourly_bookings']::text[],
       'beach'
WHERE NOT EXISTS (
  SELECT 1 FROM public.providers x WHERE x.source_service_key = 'beach'
);
