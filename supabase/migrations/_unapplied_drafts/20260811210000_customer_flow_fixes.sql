-- Three gaps in the CUSTOMER's path, found by walking it end to end.
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.
--
-- ── 1. Nudge the customers who paid and never picked a time ─────────────────
-- The reminder cron only ever collected subscriptions with status = active, so
-- a cleaning subscription sitting at pending_schedule — paid for, no visit
-- booked — got nothing at any stage. Three were live when this was written:
-- paid 5, 9 and 12 days earlier with zero bookings between them.
--
-- The de-dupe table claims one row per (subscription, stage), so the new stages
-- ride the existing machinery: at most one nudge each, ever.
--   unscheduled_1  — the day after paying, when the checkout screen is forgotten
--   unscheduled_3  — three days later, the last one they get

alter table subscription_expiration_notifications
  drop constraint if exists subscription_expiration_notifications_stage_check;

alter table subscription_expiration_notifications
  add constraint subscription_expiration_notifications_stage_check
  check (stage = any (array['2_day', '1_day', 'expired', 'unscheduled_1', 'unscheduled_3']));

comment on column subscription_expiration_notifications.stage is
  'Which reminder this row claims. 2_day / 1_day / expired are the expiry ladder; unscheduled_1 / unscheduled_3 chase a paid subscription that has never been scheduled. One row per (subscription, stage) means each is sent at most once.';

-- ── 2. A customer can stop a subscription ───────────────────────────────────
-- Until now they could not. The only cancellation on the platform was
-- cancel_cleaning_booking, which drops a single VISIT; the subscription itself
-- could be bought in two clicks and never stopped, and `cancelled` was a status
-- the code read but only an admin could write.
--
-- Cancel at the END of the paid period, never immediately: the customer has
-- paid through end_date and is owed those days. So no status changes — access
-- checks, the booking page and the nightly expiry sweep go on working exactly
-- as before, and the subscription simply stops renewing and lapses on its own
-- date. That also keeps the decision reversible until the last day.

alter table cleaning_subscriptions   add column if not exists cancel_at_period_end boolean not null default false;
alter table food_subscriptions       add column if not exists cancel_at_period_end boolean not null default false;
alter table beach_club_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table provider_subscriptions   add column if not exists cancel_at_period_end boolean not null default false;

alter table cleaning_subscriptions   add column if not exists cancel_requested_at timestamptz;
alter table food_subscriptions       add column if not exists cancel_requested_at timestamptz;
alter table beach_club_subscriptions add column if not exists cancel_requested_at timestamptz;
alter table provider_subscriptions   add column if not exists cancel_requested_at timestamptz;

comment on column cleaning_subscriptions.cancel_at_period_end is
  'The customer asked to stop. Access continues to the period end; nothing renews after it. Reversible until then — see cancel_requested_at for when they asked.';
comment on column food_subscriptions.cancel_at_period_end is
  'The customer asked to stop. Access continues to the period end; nothing renews after it. Reversible until then.';
comment on column beach_club_subscriptions.cancel_at_period_end is
  'The customer asked to stop. Access continues to the period end; nothing renews after it. Reversible until then.';
comment on column provider_subscriptions.cancel_at_period_end is
  'The customer asked to stop. Access continues to the period end; nothing renews after it. Reversible until then.';
