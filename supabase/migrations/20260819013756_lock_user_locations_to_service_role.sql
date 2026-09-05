-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260819013756 · lock_user_locations_to_service_role

-- Home addresses (physical-safety PII). All reads/writes now go through the
-- owner-scoped /account/locations API (service role); the browser no longer
-- touches this table. Lock it to service-role only, matching service_occurrences
-- and provider_payouts. RLS can't owner-scope here (custom JWT, no auth.uid()),
-- so app-layer ownership + a service-only table is the correct shape.
REVOKE ALL ON public.user_locations FROM anon, authenticated;
DROP POLICY IF EXISTS user_locations_all ON public.user_locations;
CREATE POLICY user_locations_service_only ON public.user_locations
  FOR ALL TO public
  USING (current_setting('role', true) = 'service_role')
  WITH CHECK (current_setting('role', true) = 'service_role');
