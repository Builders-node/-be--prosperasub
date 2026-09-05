-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904005733 · transport_drop_vehicles_archetype

-- A transport provider has no service-category: its products carry the type.
-- The column was NOT NULL because every provider used to live under a service.
ALTER TABLE providers ALTER COLUMN category_key DROP NOT NULL;

UPDATE providers
SET archetype_key = NULL, category_key = NULL
WHERE unit = 'transport';

-- The service-category that used to type the business, and the archetype
-- itself. Nothing else points at either (0 applications, 0 plans, 0 subs).
DELETE FROM service_categories WHERE archetype_key = 'vehicles';
DELETE FROM service_archetypes WHERE key = 'vehicles';
