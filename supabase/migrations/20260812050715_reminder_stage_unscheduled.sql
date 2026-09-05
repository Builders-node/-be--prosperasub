-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812050715 · reminder_stage_unscheduled

-- Nudge the customers who paid and never picked a time.
--
-- The reminder cron only ever collected subscriptions with status = active, so
-- a cleaning subscription sitting at pending_schedule — paid for, no visit
-- booked — got nothing at any stage. Three of them are live right now: paid 5,
-- 9 and 12 days ago with zero bookings between them. The money arrived and the
-- service never happened, and nobody was told.
--
-- The de-dupe table claims one row per (subscription, stage), so the new stages
-- ride the existing machinery: at most one nudge each, ever.
--   unscheduled_1  — the day after paying, when the checkout screen is forgotten
--   unscheduled_3  — three days later, the last one they get
--
-- Widening the CHECK is the whole schema change; nothing existing moves.

alter table subscription_expiration_notifications
  drop constraint if exists subscription_expiration_notifications_stage_check;

alter table subscription_expiration_notifications
  add constraint subscription_expiration_notifications_stage_check
  check (stage = any (array['2_day', '1_day', 'expired', 'unscheduled_1', 'unscheduled_3']));

comment on column subscription_expiration_notifications.stage is
  'Which reminder this row claims. 2_day / 1_day / expired are the expiry ladder; unscheduled_1 / unscheduled_3 chase a paid subscription that has never been scheduled. One row per (subscription, stage) means each is sent at most once.';
