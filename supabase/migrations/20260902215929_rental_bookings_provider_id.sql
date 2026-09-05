-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902215929 · rental_bookings_provider_id

-- Denormalised from the vehicle on purpose.
--
-- Revenue, commission and payouts are grouped by provider, and joining every
-- booking through rental_vehicles to find that out is both slower and wrong:
-- a car sold to another business later would silently rewrite the history of
-- who earned what. The booking records who earned it at the time.
ALTER TABLE rental_bookings
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES providers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS rental_bookings_provider_id_idx ON rental_bookings(provider_id);
