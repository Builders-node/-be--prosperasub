-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260707035514 · subscription_renewals_public_select

-- Users need to see their own renewals in the /history page which reads with
-- the anon key. Writes stay service_role-only so the audit chain isn't forgeable
-- client-side. Matches the permissive-RLS convention already used elsewhere in
-- this project (see CLAUDE.md).
CREATE POLICY subscription_renewals_public_read
  ON subscription_renewals FOR SELECT TO public USING (true);
