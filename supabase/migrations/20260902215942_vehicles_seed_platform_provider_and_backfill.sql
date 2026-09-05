-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902215942 · vehicles_seed_platform_provider_and_backfill

-- The fleet that exists today was nobody's — it predates providers entirely.
-- Give it the business it has always effectively been, so every car has an
-- owner and no code has to special-case a null one.
INSERT INTO providers (name, description, archetype_key, category_key, status,
                       is_platform_owned, capabilities, sort_order)
SELECT 'EverySub Cars', 'Car rental in Próspera.', 'vehicles', 'car_rental', 'active',
       true, ARRAY['date_range_booking']::text[], 0
WHERE NOT EXISTS (
  SELECT 1 FROM providers WHERE archetype_key = 'vehicles' AND name = 'EverySub Cars'
);

UPDATE rental_vehicles v
   SET provider_id = p.id
  FROM providers p
 WHERE p.archetype_key = 'vehicles'
   AND p.name = 'EverySub Cars'
   AND v.provider_id IS NULL;

-- Bookings take the provider their vehicle belongs to.
UPDATE rental_bookings b
   SET provider_id = v.provider_id
  FROM rental_vehicles v
 WHERE v.id = b.vehicle_id
   AND b.provider_id IS NULL
   AND v.provider_id IS NOT NULL;
