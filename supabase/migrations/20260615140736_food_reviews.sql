-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260615140736 · food_reviews

CREATE TABLE IF NOT EXISTS food_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES food_providers(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  customer_name text,
  rating        integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_food_reviews_provider ON food_reviews(provider_id);
ALTER TABLE food_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS all_food_reviews ON food_reviews;
CREATE POLICY all_food_reviews ON food_reviews FOR ALL TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all_food_reviews ON food_reviews;
CREATE POLICY service_all_food_reviews ON food_reviews FOR ALL TO service_role USING (true) WITH CHECK (true);
