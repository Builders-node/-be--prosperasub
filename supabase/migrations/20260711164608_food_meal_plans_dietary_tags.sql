-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260711164608 · food_meal_plans_dietary_tags

-- Dietary tags on meal plans. Restaurants label their plans "Keto", "Vegan",
-- "Gym" etc.; customers filter by tag on Discovery. Fixed vocabulary because:
--   • filter UI needs a stable icon/color per tag
--   • analytics ("how many Keto customers do we have?") needs canonical labels
--   • provider input errors ("Ketogenik", "keto ✅") stay out of the DB
--
-- Add new tags here + in the frontend registry (foodDietaryTags.ts). Removing
-- a tag = data migration.

ALTER TABLE public.food_meal_plans
  ADD COLUMN IF NOT EXISTS dietary_tags text[];

ALTER TABLE public.food_meal_plans
  DROP CONSTRAINT IF EXISTS food_meal_plans_dietary_tags_check;

ALTER TABLE public.food_meal_plans
  ADD CONSTRAINT food_meal_plans_dietary_tags_check CHECK (
    dietary_tags IS NULL
    OR dietary_tags <@ ARRAY[
      'keto',
      'vegan',
      'vegetarian',
      'gym',
      'high_protein',
      'low_carb',
      'diabetic',
      'pescatarian',
      'mediterranean',
      'kids',
      'gluten_free',
      'balanced'
    ]::text[]
  );

CREATE INDEX IF NOT EXISTS food_meal_plans_dietary_tags_gin
  ON public.food_meal_plans USING gin (dietary_tags);

COMMENT ON COLUMN public.food_meal_plans.dietary_tags
  IS 'Fixed-vocabulary dietary labels (keto, vegan, gym, etc). NULL/empty = no label. Frontend registry in lib/foodDietaryTags.ts.';
