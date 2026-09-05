-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260711043447 · food_catalog_provider_menu_fallback

-- Restore meal-plan photos on FoodListing.
--
-- Providers can attach a weekly menu either to a specific meal_plan_id or
-- leave meal_plan_id NULL to represent a "provider-wide" menu (one rotation
-- covering every plan). The previous version of get_food_catalog only pulled
-- images from plan-linked menus, so a provider like Elias Cuisine — which has
-- one NULL-keyed menu shared across three plans — rendered photo-less cards.
--
-- Fix: build plan-specific images first; if a plan has none, fall back to any
-- provider-level menu's images. Result shape is unchanged (still one
-- `{meal_plan_id, urls}` row per plan that has images).
CREATE OR REPLACE FUNCTION public.get_food_catalog()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
BEGIN
  WITH
    active_providers AS (
      SELECT * FROM food_providers WHERE status = 'active' ORDER BY sort_order
    ),
    provider_ids AS (SELECT id FROM active_providers),
    active_plans AS (
      SELECT p.*
      FROM food_meal_plans p
      WHERE p.provider_id IN (SELECT id FROM provider_ids)
        AND p.status = 'active'
      ORDER BY p.sort_order
    ),
    plan_ids AS (SELECT id FROM active_plans),
    prov_res AS (
      SELECT provider_id, residence_id
      FROM food_provider_residences
      WHERE provider_id IN (SELECT id FROM provider_ids)
    ),
    plan_res AS (
      SELECT meal_plan_id, residence_id
      FROM food_meal_plan_residences
      WHERE meal_plan_id IN (SELECT id FROM plan_ids)
    ),
    rating_agg AS (
      SELECT provider_id,
             AVG(rating)::float8   AS avg_rating,
             COUNT(*)::int         AS review_count
      FROM food_reviews
      WHERE provider_id IN (SELECT id FROM provider_ids)
      GROUP BY provider_id
    ),
    -- Images from menus attached directly to a plan.
    plan_direct_images AS (
      SELECT wm.meal_plan_id,
             (array_agg(mm.image_url ORDER BY mm.image_url))[1:3] AS urls
      FROM food_weekly_menus wm
      JOIN food_menu_meals mm ON mm.menu_id = wm.id
      WHERE wm.meal_plan_id IN (SELECT id FROM plan_ids)
        AND mm.image_url IS NOT NULL
      GROUP BY wm.meal_plan_id
    ),
    -- Images from provider-level menus (meal_plan_id IS NULL).
    provider_menu_images AS (
      SELECT wm.provider_id,
             (array_agg(mm.image_url ORDER BY mm.image_url))[1:3] AS urls
      FROM food_weekly_menus wm
      JOIN food_menu_meals mm ON mm.menu_id = wm.id
      WHERE wm.meal_plan_id IS NULL
        AND wm.provider_id IN (SELECT id FROM provider_ids)
        AND mm.image_url IS NOT NULL
      GROUP BY wm.provider_id
    ),
    -- Merge: plan-specific wins; otherwise fall back to the provider's shared menu.
    plan_images AS (
      SELECT p.id AS meal_plan_id,
             COALESCE(pdi.urls, pmi.urls) AS urls
      FROM active_plans p
      LEFT JOIN plan_direct_images pdi ON pdi.meal_plan_id = p.id
      LEFT JOIN provider_menu_images pmi ON pmi.provider_id = p.provider_id
      WHERE COALESCE(pdi.urls, pmi.urls) IS NOT NULL
    )
  SELECT jsonb_build_object(
    'providers',           (SELECT COALESCE(jsonb_agg(to_jsonb(active_providers.*)),'[]'::jsonb) FROM active_providers),
    'plans',               (SELECT COALESCE(jsonb_agg(to_jsonb(active_plans.*)),'[]'::jsonb)     FROM active_plans),
    'provider_residences', (SELECT COALESCE(jsonb_agg(to_jsonb(prov_res.*)),'[]'::jsonb)         FROM prov_res),
    'plan_residences',     (SELECT COALESCE(jsonb_agg(to_jsonb(plan_res.*)),'[]'::jsonb)         FROM plan_res),
    'ratings',             (SELECT COALESCE(jsonb_agg(to_jsonb(rating_agg.*)),'[]'::jsonb)       FROM rating_agg),
    'plan_images',         (SELECT COALESCE(jsonb_agg(to_jsonb(plan_images.*)),'[]'::jsonb)      FROM plan_images)
  ) INTO result;
  RETURN result;
END;
$function$;
