-- Nobody reads another person's email, name or last login with the public key.
--
-- The browser talks to PostgREST with the anon key, which ships inside the
-- site, and the app's sign-in is its own — so the database cannot tell an admin
-- from a stranger. `users` was readable column by column (email, name,
-- display_name, last_login_at, …) by anyone holding that key, without signing
-- in: every account's email in one request.
--
-- The app now asks the API instead (Edge routes/provider-customers.ts):
--   POST /account/people/lookup  names for ids the caller may know
--   GET  /account/people         the person picker (admin: all; a business: its customers)
--   GET  /account/me/uuid        the caller's own id
-- The server uses the service role, which this does not touch.
--
-- Still readable with the public key, because pages count or match on them
-- and they say nothing about a person: id, created_at, updated_at,
-- deleted_at, referral_code.
--
-- APPLY ONLY AFTER the frontend that uses those endpoints is on production —
-- the older build reads these columns directly. Safe to run twice.

revoke select on public.users from anon, authenticated;
revoke select (email, name, display_name, last_login_at, banned_until,
               lightning_pubkey, auth_provider, client_id, avatar_url)
  on public.users from anon, authenticated;
grant select (id, created_at, updated_at, deleted_at, referral_code)
  on public.users to anon, authenticated;
