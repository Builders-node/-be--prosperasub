-- Win-back reminders and "why did you leave".
--
-- 1. The reminder ledger forgot renewals. Its key was (type, subscription,
--    stage), but a renewal EXTENDS the same row — so after a customer's first
--    renewal every later "expires in 2 days / tomorrow / today" was treated as
--    already sent, for ever. Two food subscriptions ending 2026-11-09 were
--    skipped on 2026-11-07 for exactly this reason. The period end is part of
--    the key now: one message per stage PER PERIOD.
--
-- 2. Two new stages after the end — winback_7 and winback_21 — and two more
--    subscription types, so beach memberships and universal plans
--    (provider_subscriptions) get the same ladder.
--
-- 3. churn_feedback: one tap "why" from the cancel dialog and the reminder
--    emails. Service-role only (written by the Edge api, which checks that the
--    subscription belongs to the caller); no policies on purpose.

alter table public.subscription_expiration_notifications
  drop constraint if exists subscription_expiration_notif_subscription_type_subscriptio_key;

create unique index if not exists subscription_expiration_notifications_period_uidx
  on public.subscription_expiration_notifications (subscription_type, subscription_id, stage, expiration_date);

-- PostgREST's on_conflict needs a constraint or a plain unique index over these
-- exact columns; the index above is that.

alter table public.subscription_expiration_notifications
  drop constraint if exists subscription_expiration_notifications_stage_check;
alter table public.subscription_expiration_notifications
  add constraint subscription_expiration_notifications_stage_check
  check (stage = any (array['2_day','1_day','expired','winback_7','winback_21','unscheduled_1','unscheduled_3']));

alter table public.subscription_expiration_notifications
  drop constraint if exists subscription_expiration_notifications_subscription_type_check;
alter table public.subscription_expiration_notifications
  add constraint subscription_expiration_notifications_subscription_type_check
  check (subscription_type = any (array['food','cleaning','beach','plan']));

create table if not exists public.churn_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  service text not null check (service = any (array['food','cleaning','beach','plan'])),
  subscription_id text not null,
  reason text not null check (reason = any (array['moved','price','quality','forgot','other'])),
  note text check (note is null or char_length(note) <= 1000),
  source text not null default 'app' check (source = any (array['cancel','email','app'])),
  created_at timestamptz not null default now()
);

create index if not exists churn_feedback_created_idx on public.churn_feedback (created_at desc);
create index if not exists churn_feedback_sub_idx on public.churn_feedback (service, subscription_id);

alter table public.churn_feedback enable row level security;
revoke all on public.churn_feedback from anon, authenticated;

comment on table public.churn_feedback is
  'Why a customer left: one answer per tap, from the cancel dialog or a reminder email. Service-role only; written by the Edge api after an ownership check.';
