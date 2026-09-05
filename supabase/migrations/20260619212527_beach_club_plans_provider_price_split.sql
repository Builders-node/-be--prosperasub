-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260619212527 · beach_club_plans_provider_price_split

ALTER TABLE public.beach_club_plans
  ADD COLUMN IF NOT EXISTS provider_price_per_person_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.beach_club_plans
  ADD COLUMN IF NOT EXISTS extra_per_person_cents integer NOT NULL DEFAULT 0;

-- Backfill: existing plans keep the same customer price, attributed fully to the
-- provider with zero extra. Admins can rebalance afterwards.
UPDATE public.beach_club_plans
  SET provider_price_per_person_cents = price_per_person_cents
  WHERE provider_price_per_person_cents = 0;
