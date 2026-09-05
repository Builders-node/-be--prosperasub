-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260711014208 · food_subscriptions_selected_meals

-- Add per-subscription meal selection. Structured replacement for free-form
-- notes like "2 Lunch per day instead of dinner".
--
-- DB check enforces: only known meal keys, length 1..3, non-empty.
-- App layer additionally enforces:
--   • no duplicates within one subscription (dupes = separate plan)
--   • length matches the plan's meals_per_day
-- (CHECK constraints can't reference other rows/subqueries, so those two live
--  in the write path — plus a BEFORE-INSERT trigger below for dupe safety.)
ALTER TABLE public.food_subscriptions
  ADD COLUMN IF NOT EXISTS selected_meals text[];

ALTER TABLE public.food_subscriptions
  DROP CONSTRAINT IF EXISTS food_subscriptions_selected_meals_check;

ALTER TABLE public.food_subscriptions
  ADD CONSTRAINT food_subscriptions_selected_meals_check CHECK (
    selected_meals IS NULL
    OR (
      cardinality(selected_meals) BETWEEN 1 AND 3
      AND selected_meals <@ ARRAY['breakfast','lunch','dinner']::text[]
    )
  );

-- BEFORE-INSERT/UPDATE trigger to reject duplicates. Runs in the transaction,
-- so bulk imports also get the same guarantee as app writes.
CREATE OR REPLACE FUNCTION public.food_subscriptions_reject_dupe_meals()
RETURNS trigger AS $$
BEGIN
  IF NEW.selected_meals IS NOT NULL
     AND cardinality(NEW.selected_meals) <> (
       SELECT count(DISTINCT m) FROM unnest(NEW.selected_meals) AS m
     )
  THEN
    RAISE EXCEPTION 'selected_meals must not contain duplicates' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS food_subscriptions_reject_dupe_meals ON public.food_subscriptions;
CREATE TRIGGER food_subscriptions_reject_dupe_meals
  BEFORE INSERT OR UPDATE OF selected_meals ON public.food_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.food_subscriptions_reject_dupe_meals();

-- Backfill from the plan's meals_per_day.
UPDATE public.food_subscriptions s
SET selected_meals = CASE
  WHEN p.meals_per_day >= 3 THEN ARRAY['breakfast','lunch','dinner']::text[]
  WHEN p.meals_per_day = 2 THEN ARRAY['lunch','dinner']::text[]
  ELSE ARRAY['lunch']::text[]
END
FROM public.food_meal_plans p
WHERE s.meal_plan_id = p.id
  AND s.selected_meals IS NULL;

-- Fallback for orphan subscriptions with no plan link.
UPDATE public.food_subscriptions
SET selected_meals = ARRAY['lunch','dinner']::text[]
WHERE selected_meals IS NULL;

COMMENT ON COLUMN public.food_subscriptions.selected_meals
  IS 'Which meals the customer picked, subset of {breakfast, lunch, dinner}. Length equals the plan meals_per_day. Duplicates disallowed — extra portions of the same meal are a separate plan.';
