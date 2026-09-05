-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260819011306 · secure_users_and_user_roles_from_anon

-- SECURITY FIX: the browser holds only the anon key. These policies were named
-- "Service role full access" but were written USING(true) against PUBLIC, and
-- anon held full DML grants — an unauthenticated visitor could self-grant
-- super_admin (INSERT user_roles), dump/rewrite password hashes, and read
-- wallet-spending credentials (nwc_connection_string). auth_login_verify is
-- SECURITY DEFINER (owned by postgres) so login bypasses RLS and is unaffected;
-- the backend writes these tables with the service role, which bypasses RLS too.

-- === user_roles: kill privilege escalation (frontend never reads/writes it) ===
REVOKE ALL ON public.user_roles FROM anon, authenticated;
DROP POLICY IF EXISTS "Service role full access to user_roles" ON public.user_roles;
CREATE POLICY user_roles_service_only ON public.user_roles
  FOR ALL TO public
  USING (current_setting('role', true) = 'service_role')
  WITH CHECK (current_setting('role', true) = 'service_role');

-- === users: kill account takeover + hide credential columns ===
-- Frontend reads only id/email/name/display_name/deleted_at, never the secrets.
REVOKE ALL ON public.users FROM anon, authenticated;
GRANT SELECT (id, email, name, display_name, auth_provider, avatar_url,
              lightning_pubkey, created_at, last_login_at, updated_at,
              client_id, banned_until, deleted_at)
  ON public.users TO anon, authenticated;
DROP POLICY IF EXISTS "Service role full access to users" ON public.users;
-- Reads stay open (column grant above scopes them); writes are service-role only.
CREATE POLICY users_select_all ON public.users
  FOR SELECT TO public USING (true);
CREATE POLICY users_write_service ON public.users
  FOR ALL TO public
  USING (current_setting('role', true) = 'service_role')
  WITH CHECK (current_setting('role', true) = 'service_role');
