-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816213629 · subscriptions_unified_read_model

-- One shape for a subscription, whatever table it lives in.
--
-- Three tables with three price shapes, three status vocabularies and three
-- ways of naming the provider is why the same reduce loop had to be written
-- again in every screen that touches money — the analytics rollup, the finance
-- pages, the admin lists, the reminder crons. Each copy agreed with the others
-- only for as long as somebody kept checking.
--
-- This is step one of merging them: a read model. Nothing writes here and no
-- legacy table changes, so it is safe to adopt one reader at a time; when the
-- writers eventually move, this view becomes the table and the callers do not
-- notice.
--
-- Rules baked in, matching lib/analytics/platformRollup.ts exactly:
--   • price_cents is the FULL committed value (the whole term, renewals included)
--   • status is EFFECTIVE — a row whose period ended yesterday reads "expired"
--     even though the nightly sweep has not run yet
--   • provider_id is always the universal `providers.id`
create or replace view public.subscriptions_unified
with (security_invoker = true) as
with today as (select (now() at time zone 'America/Tegucigalpa')::date as d)
select
  'cleaning'::text                                as service,
  c.id::text                                      as id,
  pkg.owner_provider_id                           as provider_id,
  c.package_id::text                              as plan_id,
  c.user_id::text                                 as user_id,
  coalesce(c.total_price_cents, c.monthly_price_cents, 0)::bigint as price_cents,
  (c.payment_status = 'paid')                     as paid,
  case
    when lower(coalesce(c.subscription_status, '')) <> 'active'
      then coalesce(nullif(lower(c.subscription_status), ''), 'cancelled')
    when coalesce(c.service_end_date, c.end_date, c.paid_until) < (select d from today)
      then 'expired'
    else 'active'
  end                                             as status,
  c.payment_status,
  c.created_at,
  coalesce(c.service_start_date, c.start_date)    as starts_on,
  coalesce(c.service_end_date, c.end_date)        as ends_on,
  null::text                                      as location
from public.cleaning_subscriptions c
left join public.cleaning_packages pkg on pkg.id = c.package_id
where c.deleted_at is null

union all

select
  'food',
  f.id::text,
  pr.id,
  f.meal_plan_id::text,
  f.user_id::text,
  (coalesce(f.weekly_price_cents, 0)
     * greatest(coalesce(f.commitment_weeks, 1), 1)
     * greatest(coalesce(f.periods_paid, 1), 1))::bigint,
  (f.payment_status = 'paid'),
  case
    when lower(coalesce(f.status, '')) <> 'active'
      then coalesce(nullif(lower(f.status), ''), 'pending')
    when f.end_date < (select d from today) then 'expired'
    else 'active'
  end,
  f.payment_status,
  f.created_at,
  f.started_at::date,
  f.end_date::date,
  nullif(btrim(f.residence), '')
from public.food_subscriptions f
left join public.providers pr
  on pr.source_service_key = 'food' and pr.source_provider_id::text = f.provider_id::text

union all

select
  'beach',
  b.id::text,
  b.provider_id,
  b.plan_id::text,
  b.user_id::text,
  coalesce(b.price_cents, 0)::bigint,
  (b.payment_status = 'paid'),
  case
    when lower(coalesce(b.status, '')) <> 'active'
      then coalesce(nullif(lower(b.status), ''), 'cancelled')
    when b.end_date < (select d from today) then 'expired'
    else 'active'
  end,
  b.payment_status,
  b.created_at,
  b.start_date::date,
  b.end_date::date,
  null::text
from public.provider_subscriptions b
where b.source_service_key = 'beach';

comment on view public.subscriptions_unified is
  'One row per subscription across cleaning_subscriptions, food_subscriptions and the beach rows of provider_subscriptions. Full committed value, effective status (Honduras today), universal provider_id. Read model only — write to the underlying table. Step one of collapsing the three tables into one.';
