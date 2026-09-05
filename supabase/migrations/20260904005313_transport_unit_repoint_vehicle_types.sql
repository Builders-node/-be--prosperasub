-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904005313 · transport_unit_repoint_vehicle_types

-- Point the vehicles' type at transport's own table.
ALTER TABLE rental_vehicles DROP CONSTRAINT IF EXISTS rental_vehicles_category_key_fkey;

UPDATE rental_vehicles SET category_key = 'cars'
WHERE category_key IS DISTINCT FROM 'cars';

ALTER TABLE rental_vehicles
  ADD CONSTRAINT rental_vehicles_category_key_fkey
  FOREIGN KEY (category_key) REFERENCES rental_categories(key)
  ON UPDATE CASCADE ON DELETE SET NULL;

COMMENT ON COLUMN rental_vehicles.category_key IS
'Vehicle type — a rental_categories key. The type belongs to the PRODUCT: one provider can rent cars and motorbikes.';
