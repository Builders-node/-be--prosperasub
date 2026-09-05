-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816062738 · migrate_beach_subscriptions_to_universal

-- Beach memberships become universal subscriptions, one to one.
--
-- Five of the six existed only in `beach_club_subscriptions`; the sixth had a
-- row from the stale 2026 backfill which had since drifted (it said active
-- while the legacy row said expired). Keyed on `source_subscription_id`, so
-- this is an upsert: re-running it cannot produce a second copy of anybody's
-- membership, and the drifted row is corrected rather than duplicated.
--
-- One customer's legacy `user_id` is a Google sub string, not a uuid, and is
-- resolved through the email the way the app resolves it everywhere else. A
-- row that cannot be resolved at all is left behind rather than inserted with
-- no owner; the check after this migration counts what was left.
insert into provider_subscriptions (
  provider_id, plan_id, user_id, start_date, end_date, status, payment_status,
  payment_method, payment_reference, price_cents, metadata,
  customer_whatsapp, notes, cancel_at_period_end, cancel_requested_at,
  source_service_key, source_subscription_id
)
select
  p.id,
  pp.id,
  coalesce(
    (select u.id from users u where u.id::text = s.user_id),
    (select u.id from users u where lower(u.email) = lower(s.customer_email))
  ),
  s.start_date,
  s.end_date,
  case s.status when 'pending' then 'pending_payment' else s.status end,
  s.payment_status,
  s.payment_method,
  s.payment_reference,
  s.total_cents,
  jsonb_build_object('people', s.people, 'plan_name', s.plan_name,
                     'customer_name', s.customer_name, 'customer_email', s.customer_email),
  s.customer_whatsapp,
  s.notes,
  coalesce(s.cancel_at_period_end, false),
  s.cancel_requested_at,
  'beach',
  s.id::text
from beach_club_subscriptions s
join providers p on p.source_service_key = 'beach'
join provider_plans pp on pp.source_service_key = 'beach' and pp.source_plan_id = s.plan_id::text
where coalesce(
        (select u.id from users u where u.id::text = s.user_id),
        (select u.id from users u where lower(u.email) = lower(s.customer_email))
      ) is not null
on conflict (source_service_key, source_subscription_id)
  where source_service_key is not null and source_subscription_id is not null
do update set
  plan_id = excluded.plan_id,
  user_id = excluded.user_id,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  status = excluded.status,
  payment_status = excluded.payment_status,
  payment_method = excluded.payment_method,
  payment_reference = excluded.payment_reference,
  price_cents = excluded.price_cents,
  metadata = excluded.metadata,
  customer_whatsapp = excluded.customer_whatsapp,
  notes = excluded.notes,
  cancel_at_period_end = excluded.cancel_at_period_end,
  cancel_requested_at = excluded.cancel_requested_at,
  updated_at = now();
