-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902233425 · rental_addons_belong_to_a_provider

-- Insurance, extras and delivery zones belonged to the platform, not to a
-- business. That was invisible while one company rented cars and becomes wrong
-- the moment a second joins: it would inherit the first's coverage tiers and
-- its delivery prices, and could only change them by changing them for
-- everybody.
--
-- CASCADE is right here, unlike on vehicles and bookings. These are terms, not
-- money: a booking keeps its own `insurance_cents` and its `extras` JSON, so a
-- deleted tier cannot rewrite what somebody already paid, and there is no FK
-- from a booking to any of these.
ALTER TABLE rental_insurance_tiers
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES providers(id) ON DELETE CASCADE;
ALTER TABLE rental_extras
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES providers(id) ON DELETE CASCADE;
ALTER TABLE rental_delivery_zones
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES providers(id) ON DELETE CASCADE;

-- Everything that exists was configured for the fleet that exists.
UPDATE rental_insurance_tiers t SET provider_id = p.id
  FROM providers p WHERE p.archetype_key = 'vehicles' AND p.name = 'EverySub Cars'
   AND t.provider_id IS NULL;
UPDATE rental_extras t SET provider_id = p.id
  FROM providers p WHERE p.archetype_key = 'vehicles' AND p.name = 'EverySub Cars'
   AND t.provider_id IS NULL;
UPDATE rental_delivery_zones t SET provider_id = p.id
  FROM providers p WHERE p.archetype_key = 'vehicles' AND p.name = 'EverySub Cars'
   AND t.provider_id IS NULL;
