-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812051451 · subscription_cancel_at_period_end

-- A customer can stop a subscription.
--
-- Until now they could not. The only cancellation anywhere on the platform was
-- cancel_cleaning_booking, which drops a single VISIT; the subscription itself
-- could be started in two clicks and never stopped. `cancelled` was a status
-- the code read and only an admin could write.
--
-- Cancel at the END of the paid period, not immediately: the customer has paid
-- through end_date and is owed that. So no status changes here — access checks,
-- the booking page and the expiry sweep all keep working exactly as they do,
-- and the subscription simply stops being renewed and lapses on its own date.
-- That also makes the decision reversible right up to the last day, which
-- "cancel now" would not be.
--
-- cancelled_at is when they pressed the button, not when the plan ends.
-- food_subscriptions already had a cancelled_at, meaning something else
-- (an admin's hard cancel); the new flag is what the customer controls.

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
