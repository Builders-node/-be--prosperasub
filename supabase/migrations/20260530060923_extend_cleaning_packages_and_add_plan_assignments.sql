-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260530060923 · extend_cleaning_packages_and_add_plan_assignments


-- Step 1: Extend cleaning_packages with rich fields
ALTER TABLE cleaning_packages
  ADD COLUMN IF NOT EXISTS short_description TEXT,
  ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS apartment_type TEXT DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS service_frequency TEXT DEFAULT 'weekly',
  ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- Step 2: Sync is_active with status for backward compatibility
CREATE OR REPLACE FUNCTION sync_cleaning_package_is_active()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_cleaning_package_is_active ON cleaning_packages;
CREATE TRIGGER trg_sync_cleaning_package_is_active
  BEFORE INSERT OR UPDATE ON cleaning_packages
  FOR EACH ROW
  EXECUTE FUNCTION sync_cleaning_package_is_active();

-- Step 3: Set existing rows to have correct new column values
UPDATE cleaning_packages SET
  visibility = 'public',
  status = 'active',
  service_frequency = 'weekly',
  sort_order = CASE WHEN id = 'pkg-standard' THEN 0 ELSE 1 END;

-- Step 4: Create plan-to-client assignment junction table
CREATE TABLE IF NOT EXISTS cleaning_plan_client_assignments (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  plan_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  custom_price_cents INTEGER,
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Step 5: Enable RLS on new table
ALTER TABLE cleaning_plan_client_assignments ENABLE ROW LEVEL SECURITY;

-- Permissive policies (matches existing pattern)
CREATE POLICY "Allow all for anon" ON cleaning_plan_client_assignments FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON cleaning_plan_client_assignments FOR ALL TO authenticated USING (true) WITH CHECK (true);
