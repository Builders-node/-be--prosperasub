-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260707171403 · provider_reviews_unified

-- Shared reviews table keyed by universal providers.id — one row per
-- (provider, user). Works for cleaning / rental / entertainment / (future
-- food-migration). Food currently lives in food_reviews and stays there until
-- we do a data move; the new table + new components handle everything else.
CREATE TABLE IF NOT EXISTS provider_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  customer_name   text,
  rating          integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text,
  service         text NOT NULL CHECK (service IN ('cleaning','rental','beach','food')),
  subscription_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, user_id)
);

CREATE INDEX IF NOT EXISTS provider_reviews_provider_idx
  ON provider_reviews(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_reviews_user_idx
  ON provider_reviews(user_id, created_at DESC);

ALTER TABLE provider_reviews ENABLE ROW LEVEL SECURITY;

-- Public read (browser SELECTs via anon key)
CREATE POLICY provider_reviews_select
  ON provider_reviews FOR SELECT TO public USING (true);

-- Public write — mirrors the permissive pattern already used on config tables.
-- Client-side integrity is enforced by the UI (only "isCustomer" can post,
-- ownership check on delete). If abuse surfaces we tighten with a NestJS
-- endpoint later.
CREATE POLICY provider_reviews_write
  ON provider_reviews FOR ALL TO public USING (true) WITH CHECK (true);
