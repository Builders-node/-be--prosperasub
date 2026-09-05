-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260611015156 · food_orders_duration


ALTER TABLE public.food_orders
  ADD COLUMN IF NOT EXISTS duration_weeks INT NOT NULL DEFAULT 1;

ALTER TABLE public.food_subscriptions
  ADD COLUMN IF NOT EXISTS commitment_weeks INT NOT NULL DEFAULT 1;
