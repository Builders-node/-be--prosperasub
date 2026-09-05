-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904014349 · vehicles_unit_one_name

-- One word for the unit. It went by five: Transport (tab, sidebar), Car
-- Rental (storefront header), Rental (registry key), Fleet (admin tab) and
-- Vehicles (shelf, admin tab, URL, tables). The URL and every table already
-- said vehicles, so that is the word that survives.
UPDATE providers SET unit = 'vehicles' WHERE unit = 'transport';
UPDATE provider_applications SET unit = 'vehicles' WHERE unit = 'transport';

ALTER TABLE providers ALTER COLUMN unit SET DEFAULT 'marketplace';

COMMENT ON COLUMN providers.unit IS
'Which unit runs this business: marketplace (archetype-driven services) or vehicles. A vehicles provider has archetype_key = NULL and category_key = NULL on purpose — its products carry the type (rental_categories), not the business.';
