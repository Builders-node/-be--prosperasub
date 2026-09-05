-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706105251 · food_catalog_rpc

-- Aggregates the FoodListing catalog into a single call so the browser
-- doesn't waterfall through providers → plans → residences → reviews.
-- Returns one JSON object: {providers, plans, provider_residences,
-- plan_residences, ratings, plan_images}. Anon role can call it.
CREATE OR REPLACE FUNCTION public.get_food_catalog()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- meal images per plan (via weekly menu → menu meals)
    menu_meals AS (
      SELECT wm.meal_plan_id, mm.image_url
      FROM food_weekly_menus wm
      JOIN food_menu_meals mm ON mm.menu_id = wm.id
      WHERE wm.meal_plan_id IN (SELECT id FROM plan_ids)
        AND mm.image_url IS NOT NULL
    ),
    plan_images AS (
      SELECT meal_plan_id,
             (array_agg(image_url ORDER BY image_url))[1:3] AS urls
      FROM menu_meals
      GROUP BY meal_plan_id
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
$$;

-- Public / anon can read the catalog — same visibility as the underlying tables.
GRANT EXECUTE ON FUNCTION public.get_food_catalog() TO anon, authenticated;
