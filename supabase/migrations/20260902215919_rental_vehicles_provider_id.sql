-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260902215919 · rental_vehicles_provider_id

-- A car belongs to a business. `providers` is the identity and settlement
-- anchor for every vertical — it is what owns a workspace, what a payout is
-- computed for, and what a team is granted sight of. The car domain keeps its
-- own tables (a car is not a plan) and hangs off it by id.
--
-- RESTRICT, not CASCADE: a fleet carries bookings that carry money, and the
-- platform already refuses to let deleting a provider row eat money.
ALTER TABLE rental_vehicles
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES providers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS rental_vehicles_provider_id_idx ON rental_vehicles(provider_id);
