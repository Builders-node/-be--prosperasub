-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814061549 · backfill_cleaning_booking_provider

-- 18 cleaning bookings carry no `provider_id`. The provider workspace scopes
-- every query by that column, so their owner — almost always Car Wash — has
-- been looking at an empty Bookings tab while the visits existed.
--
-- The value is derived, not guessed: the booking names a subscription, the
-- subscription names a package, and the package names its provider. Rows that
-- cannot be resolved that way are left alone rather than assigned somewhere.
update cleaning_bookings b
set provider_id = c.provider_id,
    updated_at = now()
from cleaning_subscriptions s
join cleaning_packages c on c.id = s.package_id
where b.provider_id is null
  and s.id = coalesce(b.cleaning_subscription_id, b.subscription_id)
  and c.provider_id is not null;
