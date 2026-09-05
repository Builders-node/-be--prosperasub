-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904005323 · providers_unit_marker

-- Which unit a business belongs to. Transport providers are ordinary
-- `providers` rows — same workspace, wallet, payouts and Team — but they sit
-- outside the marketplace's Service → Category → Provider tree, so they can
-- no longer be identified by an archetype (they have none).
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'marketplace';

COMMENT ON COLUMN providers.unit IS
'Which unit runs this business: marketplace (archetype-driven services) or transport (vehicles). A transport provider has archetype_key = NULL and category_key = NULL on purpose — its products carry the type, not the business.';

UPDATE providers SET unit = 'transport' WHERE archetype_key = 'vehicles';

-- Applications know their unit too, so a rental company can apply without an
-- archetype to point at.
ALTER TABLE provider_applications
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'marketplace';
