-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260610213033 · food_menu_meals_type


ALTER TABLE public.food_menu_meals
  ADD COLUMN IF NOT EXISTS meal_type TEXT NOT NULL DEFAULT 'meal'
  CHECK (meal_type IN ('breakfast','lunch','dinner','snack','other','meal'));
