-- Privacy, step 2 part 2: phones, addresses and the wallet connection string
-- in user_profiles are no longer readable with the public key.
--
-- Readable by anyone holding the anon key until now: phone_number, whatsapp,
-- telegram_username, every address column — and nwc_connection, a Nostr
-- Wallet Connect string that can SPEND from the wallet it names (no row has
-- one today; nothing in the app reads it).
--
-- The app reads profiles through the API now (Edge routes/provider-customers.ts:
-- GET /account/profile, POST /account/profiles/lookup — yourself; an admin,
-- everyone; a business, its own customers and team). Writes from the browser
-- are unchanged: an upsert on user_id needs SELECT only on user_id, which
-- stays, and the writes return only id + user_id.
--
-- APPLY AFTER the frontend that reads profiles through the API is on
-- production. Safe to run twice.

revoke select on public.user_profiles from anon, authenticated;
grant select (id, user_id, created_at, updated_at) on public.user_profiles to anon, authenticated;
