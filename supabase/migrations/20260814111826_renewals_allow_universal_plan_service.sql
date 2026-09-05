-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814111826 · renewals_allow_universal_plan_service

-- The audit table's `service` was an enum of the four legacy verticals. Two
-- things changed: car rental was removed entirely (no row ever used it), and
-- universal `provider_subscriptions` now renew like everything else, so they
-- need a name of their own.
alter table subscription_renewals drop constraint subscription_renewals_service_check;
alter table subscription_renewals add constraint subscription_renewals_service_check
  check (service = any (array['food'::text, 'cleaning'::text, 'beach'::text, 'plan'::text]));
