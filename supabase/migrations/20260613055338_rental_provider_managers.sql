-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260613055338 · rental_provider_managers


-- Add owner column to rental_providers
ALTER TABLE rental_providers ADD COLUMN admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Create rental_provider_managers table (mirrors food_restaurant_managers)
CREATE TABLE rental_provider_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES rental_providers(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  user_email text,
  user_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rental_provider_managers_provider ON rental_provider_managers(provider_id);

-- RLS: permissive (matches other service tables)
ALTER TABLE rental_provider_managers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON rental_provider_managers FOR ALL TO public USING (true) WITH CHECK (true);
