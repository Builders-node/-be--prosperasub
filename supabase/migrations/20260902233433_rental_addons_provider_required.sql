-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902233433 · rental_addons_provider_required

-- NULL would mean "shared by everyone", which is the ambiguity being removed.
ALTER TABLE rental_insurance_tiers  ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE rental_extras           ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE rental_delivery_zones   ALTER COLUMN provider_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS rental_insurance_tiers_provider_idx ON rental_insurance_tiers(provider_id);
CREATE INDEX IF NOT EXISTS rental_extras_provider_idx          ON rental_extras(provider_id);
CREATE INDEX IF NOT EXISTS rental_delivery_zones_provider_idx  ON rental_delivery_zones(provider_id);
