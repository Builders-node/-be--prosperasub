-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260613042155 · add_rental_providers


-- Rental providers (car rental companies)
CREATE TABLE rental_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  logo_url text,
  contact_phone text,
  contact_email text,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: permissive public access (matches other service tables)
ALTER TABLE rental_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_write" ON rental_providers FOR ALL TO public USING (true) WITH CHECK (true);

-- Link vehicles to providers (nullable so existing vehicles keep working)
ALTER TABLE rental_vehicles ADD COLUMN provider_id uuid REFERENCES rental_providers(id) ON DELETE SET NULL;

-- Index for filtering vehicles by provider
CREATE INDEX idx_rental_vehicles_provider ON rental_vehicles(provider_id) WHERE provider_id IS NOT NULL;
