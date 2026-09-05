-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260605034832 · rental_vehicles_add_period_prices

ALTER TABLE public.rental_vehicles
  ADD COLUMN IF NOT EXISTS weekly_price_cents   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS biweekly_price_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_price_cents  INT NOT NULL DEFAULT 0;
