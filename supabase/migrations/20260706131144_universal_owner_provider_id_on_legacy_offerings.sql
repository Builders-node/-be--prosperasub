-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706131144 · universal_owner_provider_id_on_legacy_offerings

-- Cleaning packages ────────────────────────────────────────────────────
ALTER TABLE cleaning_packages
  ADD COLUMN IF NOT EXISTS owner_provider_id UUID REFERENCES providers(id) ON DELETE SET NULL;

UPDATE cleaning_packages cp
  SET owner_provider_id = p.id
  FROM providers p
  WHERE p.source_provider_id = cp.provider_id
    AND cp.owner_provider_id IS NULL;

CREATE INDEX IF NOT EXISTS cleaning_packages_owner_provider_id_idx
  ON cleaning_packages(owner_provider_id);

-- Rental vehicles ───────────────────────────────────────────────────────
ALTER TABLE rental_vehicles
  ADD COLUMN IF NOT EXISTS owner_provider_id UUID REFERENCES providers(id) ON DELETE SET NULL;

UPDATE rental_vehicles rv
  SET owner_provider_id = p.id
  FROM providers p
  WHERE p.source_provider_id = rv.provider_id
    AND rv.owner_provider_id IS NULL;

CREATE INDEX IF NOT EXISTS rental_vehicles_owner_provider_id_idx
  ON rental_vehicles(owner_provider_id);

-- Beach club plans (no legacy provider table — direct backfill to Beach Club)
ALTER TABLE beach_club_plans
  ADD COLUMN IF NOT EXISTS owner_provider_id UUID REFERENCES providers(id) ON DELETE SET NULL;

UPDATE beach_club_plans
  SET owner_provider_id = '00000000-0000-0000-0000-000000beac41'::uuid
  WHERE owner_provider_id IS NULL;

CREATE INDEX IF NOT EXISTS beach_club_plans_owner_provider_id_idx
  ON beach_club_plans(owner_provider_id);
