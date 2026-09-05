-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260903234902 · rental_vehicles_category_key

-- The type of a rental item is a property of the PRODUCT, not the business:
-- one provider can rent cars AND motorbikes. NULL falls back to the
-- provider's own category in readers, so nothing breaks mid-rollout.
ALTER TABLE rental_vehicles
  ADD COLUMN IF NOT EXISTS category_key text
  REFERENCES service_categories(key) ON UPDATE CASCADE ON DELETE SET NULL;

COMMENT ON COLUMN rental_vehicles.category_key IS
'Vehicle type (service_categories under the vehicles archetype: car_rental, motorbikes, …). NULL = inherit the provider''s category. Storefront chips and the admin fleet filter by THIS, never by the provider''s category.';

-- Backfill: every existing vehicle takes its provider's category.
UPDATE rental_vehicles v
SET category_key = p.category_key
FROM providers p
WHERE p.id = v.provider_id
  AND v.category_key IS NULL
  AND p.category_key IS NOT NULL;
