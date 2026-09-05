-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260615065247 · food_weekly_menu_delivery_times

ALTER TABLE food_weekly_menus
  ADD COLUMN IF NOT EXISTS delivery_times jsonb NOT NULL DEFAULT '{}'::jsonb;
