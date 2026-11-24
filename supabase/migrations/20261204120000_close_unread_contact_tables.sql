-- Privacy, step 2 part 1: contact data the browser never reads, closed to the
-- public key.
--
-- These tables were readable by anyone holding the anon key (it ships inside
-- the site), and nothing in the app reads them from the browser:
--
--   beach_club_subscriptions     customer email, name, WhatsApp (legacy shadow
--                                of the beach memberships; written only by the
--                                SECURITY DEFINER mirror trigger)
--   admin_payment_notifications  client email, name, phone (server-written)
--   food_orders                  customer name, WhatsApp, delivery address
--
-- The legacy manager tables are read by the browser for provider_id only, so
-- they keep everything but the person: user_email (and user_name) go. The two
-- readers that matched managers by email now match by user_id (every row has
-- one).
--
-- The server (Edge, Nest) uses the service role, which this does not touch.
-- APPLY AFTER the frontend that stops matching managers by email is on
-- production. Safe to run twice.

revoke select on public.beach_club_subscriptions from anon, authenticated;
revoke all on public.admin_payment_notifications from anon, authenticated;
revoke select on public.food_orders from anon, authenticated;

revoke select on public.food_restaurant_managers from anon, authenticated;
grant select (id, provider_id, user_id, created_at) on public.food_restaurant_managers to anon, authenticated;

revoke select on public.cleaning_provider_managers from anon, authenticated;
grant select (id, provider_id, user_id, role, created_at) on public.cleaning_provider_managers to anon, authenticated;

revoke select on public.beach_provider_managers from anon, authenticated;
grant select (id, provider_id, user_id, role, created_at) on public.beach_provider_managers to anon, authenticated;
