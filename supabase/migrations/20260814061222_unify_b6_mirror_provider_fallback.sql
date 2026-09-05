-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814061222 · unify_b6_mirror_provider_fallback

-- 18 cleaning bookings carry no `provider_id`, so the mirror had nothing to
-- attach them to. Their subscription's package names the provider, and that is
-- not a guess — so fall back to it rather than dropping the occurrence.
--
-- This fixes the MIRROR. The legacy column is still null on those rows, which
-- is a live bug of its own: the provider workspace scopes by it, so Car Wash's
-- owner currently sees none of their own bookings.
create or replace function mirror_cleaning_provider_of(p_booking cleaning_bookings)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
    from providers p
   where p.source_service_key = 'cleaning'
     and p.source_provider_id::text = coalesce(
           p_booking.provider_id::text,
           (select c.provider_id::text
              from cleaning_subscriptions s
              join cleaning_packages c on c.id = s.package_id
             where s.id = coalesce(p_booking.cleaning_subscription_id, p_booking.subscription_id))
         )
   limit 1;
$$;
