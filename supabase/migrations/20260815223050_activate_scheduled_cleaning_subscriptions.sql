-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260815223050 · activate_scheduled_cleaning_subscriptions

-- Two subscriptions say "awaiting schedule" while holding twelve visits.
--
-- A cleaning subscription sits on `pending_schedule` from payment until the
-- days are picked. The browser flow flips it to `active` when it generates the
-- visits; the partner endpoint booked them and never touched the subscription,
-- so the admin list kept showing "Awaiting schedule" and the daily reminder
-- kept chasing customers who had already been scheduled.
--
-- The endpoint is fixed; this is the state it left behind. Only rows that are
-- paid, still pending_schedule, and actually hold a booking — nothing is
-- activated on the strength of the badge alone.
update public.cleaning_subscriptions s
   set subscription_status = 'active',
       is_active = true,
       updated_at = now()
 where s.payment_status = 'paid'
   and s.subscription_status = 'pending_schedule'
   and exists (select 1 from public.cleaning_bookings b where b.subscription_id = s.id::text);
