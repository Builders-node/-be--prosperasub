-- Discounts a business runs on its own offers.
--
-- Three kinds, all automatic (no code to type) and all chosen by the server:
--   sale    — N% or $N off, for everyone, between two dates.
--   intro   — N% or $N off the first 1–3 periods, for a customer who has never
--             paid this business before.
--   prepay  — N% off for buying several periods at once (tiers: 3 → 10%, …).
-- Promo codes stay what they were (promo_codes); this is the other half.
--
-- The rules that make it money-safe are the promo-code rules again:
--   * the table is service-role only; the browser reads what is on through
--     active_discounts() and asks what one is worth through
--     discount_quote_for_plan(), and has no write path at all;
--   * a trigger recomputes the discount from the order row and refuses a
--     larger one, so a page can claim whatever it likes;
--   * discounts never stack: an order carries a discount OR a promo code.
--
-- Who pays: the business. Its own discount comes off what it earns and the
-- commission is taken on the discounted price — `provider_discount_cents` is
-- stamped on every order with the business-funded part (its discount, minus
-- any share a platform campaign covers, plus its own promo codes). A platform
-- promo code is still the platform's.
--
-- Safe to run twice.

-- ── Platform campaigns a business can join (e.g. "Black Friday") ─────────────
create table if not exists public.discount_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null check (char_length(title) between 2 and 80),
  description        text check (description is null or char_length(description) <= 400),
  min_percent_off    integer not null default 10 check (min_percent_off between 1 and 90),
  platform_share_pct integer not null default 0 check (platform_share_pct between 0 and 100),
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'active' check (status in ('active', 'ended')),
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (ends_at > starts_at)
);
alter table public.discount_campaigns enable row level security;
revoke all on public.discount_campaigns from anon, authenticated;
comment on table public.discount_campaigns is
  'Platform-wide sales a business joins with one tap; platform_share_pct of each discount is paid by the platform. Service-role only (Edge routes/discounts.ts).';

-- ── The discounts ────────────────────────────────────────────────────────────
create table if not exists public.provider_discounts (
  id                 uuid primary key default gen_random_uuid(),
  provider_id        uuid not null references public.providers(id) on delete cascade,
  campaign_id        uuid references public.discount_campaigns(id) on delete set null,
  kind               text not null check (kind in ('sale', 'intro', 'prepay')),
  title              text check (title is null or char_length(title) <= 80),
  value_type         text not null default 'percent' check (value_type in ('percent', 'fixed')),
  percent_off        integer check (percent_off is null or percent_off between 1 and 90),
  amount_off_cents   integer check (amount_off_cents is null or amount_off_cents between 100 and 1000000),
  -- prepay: [{"periods":3,"percent_off":10}, …], periods ascending.
  tiers              jsonb,
  -- intro: how many of the first periods are discounted.
  intro_periods      integer not null default 1 check (intro_periods between 1 and 12),
  -- provider_plans ids (an offer covers its variants) or rental_vehicles ids.
  -- NULL = everything the business sells.
  target_ids         uuid[],
  min_order_cents    integer not null default 0 check (min_order_cents >= 0),
  max_redemptions    integer check (max_redemptions is null or max_redemptions > 0),
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,
  status             text not null default 'active' check (status in ('active', 'paused', 'ended')),
  -- An admin can switch any discount off; the business cannot switch it back.
  admin_hidden       boolean not null default false,
  admin_note         text,
  platform_share_pct integer not null default 0 check (platform_share_pct between 0 and 100),
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint provider_discounts_window_ck check (ends_at is null or ends_at > starts_at),
  constraint provider_discounts_value_ck check (
    (kind = 'prepay' and value_type = 'percent' and jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) between 1 and 4)
    or (kind <> 'prepay' and value_type = 'percent' and percent_off is not null and amount_off_cents is null)
    or (kind <> 'prepay' and value_type = 'fixed' and amount_off_cents is not null and percent_off is null)
  )
);
create index if not exists provider_discounts_provider_idx on public.provider_discounts (provider_id, created_at desc);
create index if not exists provider_discounts_live_idx on public.provider_discounts (status, starts_at, ends_at) where not admin_hidden;
-- One entry per campaign per business.
create unique index if not exists provider_discounts_campaign_uidx
  on public.provider_discounts (provider_id, campaign_id) where campaign_id is not null;

alter table public.provider_discounts enable row level security;
revoke all on public.provider_discounts from anon, authenticated;
comment on table public.provider_discounts is
  'A business''s own automatic discounts (sale / intro / prepay). Service-role only: written by the Edge api (routes/discounts.ts), read by the storefront through active_discounts() and priced by discount_quote*().';

-- One row per paid order that used a discount — what max_redemptions counts.
create table if not exists public.discount_redemptions (
  id             uuid primary key default gen_random_uuid(),
  discount_id    uuid not null references public.provider_discounts(id) on delete cascade,
  provider_id    uuid,
  user_id        text,
  order_table    text not null,
  order_id       text not null,
  discount_cents integer not null,
  revenue_cents  integer not null default 0,
  new_customer   boolean not null default false,
  created_at     timestamptz not null default now()
);
create unique index if not exists discount_redemptions_order_uidx on public.discount_redemptions (order_table, order_id);
create index if not exists discount_redemptions_discount_idx on public.discount_redemptions (discount_id);
alter table public.discount_redemptions enable row level security;
revoke all on public.discount_redemptions from anon, authenticated;

-- ── Price history: the struck-through price must be a real one ───────────────
-- A sale shows the LOWEST price of the last 30 days as the old price, so a
-- price raised the week before a "−30%" cannot make the badge bigger.
create table if not exists public.provider_plan_price_log (
  id          bigint generated always as identity primary key,
  plan_id     uuid not null references public.provider_plans(id) on delete cascade,
  price_cents integer not null,
  changed_at  timestamptz not null default now()
);
create index if not exists provider_plan_price_log_plan_idx on public.provider_plan_price_log (plan_id, changed_at desc);
alter table public.provider_plan_price_log enable row level security;
revoke all on public.provider_plan_price_log from anon, authenticated;

insert into public.provider_plan_price_log (plan_id, price_cents, changed_at)
select p.id, coalesce(p.price_cents, 0), least(p.created_at, now() - interval '31 days')
  from public.provider_plans p
 where not exists (select 1 from public.provider_plan_price_log l where l.plan_id = p.id);

create or replace function public.log_plan_price()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.price_cents is distinct from old.price_cents then
    insert into public.provider_plan_price_log (plan_id, price_cents) values (new.id, coalesce(new.price_cents, 0));
  end if;
  return new;
exception when others then
  return new;  -- bookkeeping never blocks a plan edit
end $$;
revoke all on function public.log_plan_price() from public, anon, authenticated;
drop trigger if exists provider_plans_log_price on public.provider_plans;
create trigger provider_plans_log_price after insert or update of price_cents on public.provider_plans
  for each row execute function public.log_plan_price();

-- The lowest price this plan has had at any moment in the last 30 days.
create or replace function public.plan_reference_price(p_plan uuid)
returns integer language sql stable security definer set search_path = public as $$
  select min(price_cents)::integer from (
    (select price_cents from public.provider_plan_price_log
      where plan_id = p_plan and changed_at <= now() - interval '30 days'
      order by changed_at desc limit 1)
    union all
    select price_cents from public.provider_plan_price_log
     where plan_id = p_plan and changed_at > now() - interval '30 days'
    union all
    select price_cents from public.provider_plans where id = p_plan
  ) s where price_cents > 0
$$;
revoke all on function public.plan_reference_price(uuid) from public;
grant execute on function public.plan_reference_price(uuid) to anon, authenticated, service_role;

-- ── Order columns ────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['provider_subscriptions','food_subscriptions','cleaning_subscriptions','rental_bookings'] loop
    execute format('alter table public.%I add column if not exists offer_discount_id uuid', t);
    execute format('alter table public.%I add column if not exists offer_discount_cents integer not null default 0', t);
    execute format('alter table public.%I add column if not exists provider_discount_cents integer not null default 0', t);
  end loop;
end $$;
comment on column public.provider_subscriptions.offer_discount_cents is
  'An automatic discount (provider_discounts) taken off this order. The price column keeps the full figure; the guard trigger checks this one.';
comment on column public.provider_subscriptions.provider_discount_cents is
  'Stamped, never written: the part of this order''s discounts the BUSINESS pays (its discount minus a campaign''s platform share, plus its own promo codes). Earnings subtract it.';

-- PayPal: a plan whose first cycle is cheaper (an intro or a sale on the first term).
alter table public.paypal_billing_plans add column if not exists trial_price_cents integer;
-- One PayPal plan per price AND first-cycle price: the old key would refuse a
-- trial plan beside the regular one.
alter table public.paypal_billing_plans
  drop constraint if exists paypal_billing_plans_provider_plan_id_env_unit_price_cents__key;
create unique index if not exists paypal_billing_plans_price_trial_uidx
  on public.paypal_billing_plans (provider_plan_id, env, unit_price_cents, currency, interval_unit, interval_count, trial_price_cents)
  nulls not distinct;

-- ── Helpers ──────────────────────────────────────────────────────────────────
-- What an order row bought, as the id a discount targets, plus its offer.
create or replace function public.order_discount_target(p_table text, p_row jsonb)
returns table (target_id uuid, parent_id uuid)
language sql stable security definer set search_path = public as $$
  select pp.id, pp.parent_plan_id from public.provider_plans pp
   where p_table = 'provider_subscriptions' and pp.id = nullif(p_row->>'plan_id', '')::uuid
  union all
  select pp.id, pp.parent_plan_id from public.provider_plans pp
   where p_table = 'food_subscriptions' and pp.source_plan_id = p_row->>'meal_plan_id'
  union all
  select pp.id, pp.parent_plan_id from public.provider_plans pp
   where p_table = 'cleaning_subscriptions' and pp.source_plan_id = p_row->>'package_id'
  union all
  select nullif(p_row->>'vehicle_id', '')::uuid, null::uuid where p_table = 'rental_bookings'
  limit 1
$$;
revoke all on function public.order_discount_target(text, jsonb) from public, anon, authenticated;

create or replace function public.order_periods(p_table text, p_row jsonb)
returns integer language sql immutable set search_path = public as $$
  select greatest(1, coalesce(case p_table
    when 'provider_subscriptions' then (p_row->>'periods_paid')::integer
    when 'food_subscriptions'     then (p_row->>'commitment_weeks')::integer
    when 'cleaning_subscriptions' then (p_row->>'billing_period_months')::integer
    else 1 end, 1))
$$;

-- Has this person ever paid this business? (Any service, any table.)
create or replace function public.customer_has_paid(p_provider uuid, p_user text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_provider is not null and p_user is not null and (
    exists (select 1 from public.provider_subscriptions s
             where s.provider_id = p_provider and s.user_id::text = p_user and s.payment_status = 'paid')
    or exists (select 1 from public.rental_bookings b
                where b.provider_id = p_provider and b.user_id = p_user and b.payment_status = 'paid')
    or exists (select 1 from public.providers pr join public.food_subscriptions f
                 on pr.source_service_key = 'food' and f.provider_id = pr.source_provider_id::uuid
                where pr.id = p_provider and f.user_id = p_user and f.payment_status = 'paid')
    or exists (select 1 from public.providers pr join public.cleaning_subscriptions c
                 on pr.source_service_key = 'cleaning' and c.provider_id = pr.source_provider_id::uuid
                where pr.id = p_provider and c.user_id = p_user and c.payment_status = 'paid')
  )
$$;
revoke all on function public.customer_has_paid(uuid, text) from public, anon, authenticated;

create or replace function public.discount_max_pct()
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::integer end
       from public.global_settings where key = 'discount_max_pct' limit 1), 70)
$$;

-- ── What a discount is worth on one order ────────────────────────────────────
-- The single source of truth: the checkout asks it, the guard asks it again.
-- With p_discount_id it prices that one discount; without, it picks the best
-- one that applies (a customer always gets the larger, never both).
create or replace function public.discount_quote(
  p_provider     uuid,
  p_target       uuid,
  p_parent       uuid,
  p_user         text,
  p_periods      integer,
  p_amount_cents integer,
  p_discount_id  uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d        public.provider_discounts%rowtype;
  periods  integer := greatest(coalesce(p_periods, 1), 1);
  amount   integer := coalesce(p_amount_cents, 0);
  per      numeric;
  n        integer;
  value    integer;
  tier     jsonb;
  tier_pct integer;
  cap      integer;
  is_new   boolean;
  best     jsonb := null;
  best_v   integer := 0;
begin
  if p_provider is null or amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no-amount');
  end if;
  per := amount::numeric / periods;
  cap := least(amount - 1, (amount * public.discount_max_pct()) / 100);

  for d in
    select * from public.provider_discounts x
     where x.provider_id = p_provider
       and x.status = 'active' and not x.admin_hidden
       and x.starts_at <= now() and (x.ends_at is null or x.ends_at > now())
       and (p_discount_id is null or x.id = p_discount_id)
       and (x.target_ids is null or p_target = any (x.target_ids) or (p_parent is not null and p_parent = any (x.target_ids)))
       and amount >= x.min_order_cents
  loop
    if d.max_redemptions is not null and
       (select count(*) from public.discount_redemptions r where r.discount_id = d.id) >= d.max_redemptions then
      continue;
    end if;

    value := 0;
    if d.kind = 'sale' then
      value := case when d.value_type = 'percent' then floor(amount * d.percent_off / 100.0)
                    else d.amount_off_cents * periods end;
    elsif d.kind = 'intro' then
      if is_new is null then
        is_new := p_user is not null and not public.customer_has_paid(p_provider, p_user);
      end if;
      if not is_new then continue; end if;
      n := least(periods, d.intro_periods);
      value := case when d.value_type = 'percent' then floor(per * n * d.percent_off / 100.0)
                    else d.amount_off_cents * n end;
    elsif d.kind = 'prepay' then
      tier_pct := null;
      for tier in select * from jsonb_array_elements(d.tiers) loop
        if (tier->>'periods')::integer <= periods then
          tier_pct := greatest(coalesce(tier_pct, 0), (tier->>'percent_off')::integer);
        end if;
      end loop;
      if tier_pct is null then continue; end if;
      value := floor(amount * tier_pct / 100.0);
    end if;

    value := least(greatest(value, 0), greatest(cap, 0));
    if value > best_v then
      best_v := value;
      best := jsonb_build_object(
        'ok', true, 'discount_id', d.id, 'discount_cents', value, 'kind', d.kind,
        'title', d.title, 'platform_share_pct', d.platform_share_pct,
        'percent_off', d.percent_off, 'intro_periods', d.intro_periods, 'ends_at', d.ends_at);
    end if;
  end loop;

  return coalesce(best, jsonb_build_object('ok', false, 'reason', 'none'));
end $$;
revoke all on function public.discount_quote(uuid, uuid, uuid, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.discount_quote(uuid, uuid, uuid, text, integer, integer, uuid) to service_role;

-- The checkout's question, by plan id (universal id or a legacy plan id).
create or replace function public.discount_quote_for_plan(
  p_plan_id      text,
  p_user_id      text,
  p_periods      integer,
  p_amount_cents integer
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare pp record;
begin
  select id, parent_plan_id, provider_id into pp from public.provider_plans
   where id::text = p_plan_id or source_plan_id = p_plan_id
   order by (id::text = p_plan_id) desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown-plan'); end if;
  return public.discount_quote(pp.provider_id, pp.id, pp.parent_plan_id, nullif(btrim(p_user_id), ''),
                               p_periods, p_amount_cents, null);
end $$;
revoke all on function public.discount_quote_for_plan(text, text, integer, integer) from public;
grant execute on function public.discount_quote_for_plan(text, text, integer, integer) to anon, authenticated, service_role;

-- The same question for a car (the booking page's estimate; the server books
-- with discount_quote itself). Car price only — not insurance or extras.
create or replace function public.discount_quote_for_vehicle(
  p_vehicle_id   uuid,
  p_user_id      text,
  p_amount_cents integer
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare prov uuid;
begin
  select provider_id into prov from public.rental_vehicles where id = p_vehicle_id;
  if prov is null then return jsonb_build_object('ok', false, 'reason', 'unknown-vehicle'); end if;
  return public.discount_quote(prov, p_vehicle_id, null, nullif(btrim(p_user_id), ''), 1, p_amount_cents, null);
end $$;
revoke all on function public.discount_quote_for_vehicle(uuid, text, integer) from public;
grant execute on function public.discount_quote_for_vehicle(uuid, text, integer) to anon, authenticated, service_role;

-- What the storefront shows: every discount that is on right now (or starts
-- within a week, for "starts Friday"), without the counters. Prices for the
-- struck-through figure come with each sale: the lowest of the last 30 days.
create or replace function public.active_discounts()
returns table (
  id uuid, provider_id uuid, kind text, title text, value_type text,
  percent_off integer, amount_off_cents integer, tiers jsonb, intro_periods integer,
  target_ids uuid[], min_order_cents integer, starts_at timestamptz, ends_at timestamptz,
  reference_prices jsonb
) language sql stable security definer set search_path = public as $$
  select d.id, d.provider_id, d.kind, d.title, d.value_type, d.percent_off, d.amount_off_cents,
         d.tiers, d.intro_periods, d.target_ids, d.min_order_cents, d.starts_at, d.ends_at,
         case when d.kind = 'sale' then (
           select coalesce(jsonb_object_agg(p.id, public.plan_reference_price(p.id)), '{}'::jsonb)
             from public.provider_plans p
            where p.provider_id = d.provider_id
              and (d.target_ids is null or p.id = any (d.target_ids) or p.parent_plan_id = any (d.target_ids))
              and exists (select 1 from public.provider_plan_price_log l
                           where l.plan_id = p.id and l.changed_at > now() - interval '30 days')
         ) else '{}'::jsonb end
    from public.provider_discounts d
   where d.status = 'active' and not d.admin_hidden
     and d.starts_at <= now() + interval '7 days'
     and (d.ends_at is null or d.ends_at > now())
     and (d.max_redemptions is null or
          (select count(*) from public.discount_redemptions r where r.discount_id = d.id) < d.max_redemptions)
$$;
revoke all on function public.active_discounts() from public;
grant execute on function public.active_discounts() to anon, authenticated, service_role;

-- ── The guard ────────────────────────────────────────────────────────────────
create or replace function public.discount_guard_on_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j      jsonb;
  prov   uuid;
  tgt    record;
  base   integer;
  quote  jsonb;
begin
  if new.offer_discount_id is null then
    if coalesce(new.offer_discount_cents, 0) <> 0 then
      raise exception 'a discount needs its offer_discount_id' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if coalesce(new.offer_discount_cents, 0) < 0 then
    raise exception 'a discount cannot be negative' using errcode = 'check_violation';
  end if;
  -- One reduction per order: the larger of a code and a discount, never both.
  if coalesce(new.promo_discount_cents, 0) > 0 and coalesce(new.offer_discount_cents, 0) > 0 then
    raise exception 'a discount and a promo code cannot be combined' using errcode = 'check_violation';
  end if;
  -- Re-saving a row the guard already passed (a status change, a renewal) is
  -- not a new claim.
  if tg_op = 'UPDATE' and new.offer_discount_id is not distinct from old.offer_discount_id
     and new.offer_discount_cents <= old.offer_discount_cents then
    return new;
  end if;

  j := to_jsonb(new);
  prov := public.order_universal_provider(tg_table_name, j);
  select * into tgt from public.order_discount_target(tg_table_name, j);
  base := public.order_base_cents(tg_table_name, j);
  quote := public.discount_quote(prov, tgt.target_id, tgt.parent_id, j->>'user_id',
                                 public.order_periods(tg_table_name, j), base, new.offer_discount_id);
  if not coalesce((quote->>'ok')::boolean, false) then
    raise exception 'discount %: %', new.offer_discount_id, coalesce(quote->>'reason', 'does not apply')
      using errcode = 'check_violation';
  end if;
  if new.offer_discount_cents > (quote->>'discount_cents')::integer then
    raise exception 'discount is worth % cents, not %', quote->>'discount_cents', new.offer_discount_cents
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function public.discount_guard_on_order() from public, anon, authenticated;

-- Who pays for this order's reductions — stamped, never trusted from a writer.
create or replace function public.stamp_discount_funding()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  share   integer := 0;
  own     integer := 0;
begin
  if new.offer_discount_id is not null and coalesce(new.offer_discount_cents, 0) > 0 then
    select platform_share_pct into share from public.provider_discounts where id = new.offer_discount_id;
    own := new.offer_discount_cents - (new.offer_discount_cents * coalesce(share, 0)) / 100;
  end if;
  if new.promo_code is not null and coalesce(new.promo_discount_cents, 0) > 0 and exists (
       select 1 from public.promo_codes c
        where upper(c.code) = upper(new.promo_code) and c.provider_id is not null) then
    own := own + new.promo_discount_cents;
  end if;
  new.provider_discount_cents := greatest(own, 0);
  return new;
exception when others then
  return new;
end $$;
revoke all on function public.stamp_discount_funding() from public, anon, authenticated;

-- Spent when paid, exactly like a promo code.
create or replace function public.discount_redeem_on_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb;
begin
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;
  if new.offer_discount_id is null or coalesce(new.offer_discount_cents, 0) <= 0 then return new; end if;
  j := to_jsonb(new);
  begin
    insert into public.discount_redemptions
      (discount_id, provider_id, user_id, order_table, order_id, discount_cents, revenue_cents, new_customer)
    select new.offer_discount_id, d.provider_id, j->>'user_id', tg_table_name::text, new.id::text, new.offer_discount_cents,
           greatest(public.order_base_cents(tg_table_name, j) - new.offer_discount_cents, 0),
           d.kind = 'intro'
      from public.provider_discounts d where d.id = new.offer_discount_id
    on conflict (order_table, order_id) do nothing;
  exception when others then
    raise warning 'discount redemption failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.discount_redeem_on_paid() from public, anon, authenticated;

-- A promo code on a food or cleaning order was checked against the LEGACY
-- provider id, so a business's own code never matched there. Same check, the
-- universal id.
create or replace function public.promo_guard_on_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_json jsonb;
  base     integer;
  uid      uuid;
  quote    jsonb;
begin
  if new.promo_code is null or btrim(new.promo_code) = '' then
    if coalesce(new.promo_discount_cents, 0) <> 0 then
      raise exception 'a discount needs a promo code' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  row_json := to_jsonb(new);
  base := public.order_base_cents(tg_table_name::text, row_json);
  uid := public.order_user_uuid(row_json);

  quote := public.promo_quote(new.promo_code, uid,
             coalesce(public.order_universal_provider(tg_table_name, row_json), (row_json->>'provider_id')::uuid), base);

  if not (quote->>'ok')::boolean then
    raise exception 'promo code %: %', new.promo_code, quote->>'reason'
      using errcode = 'check_violation';
  end if;

  if coalesce(new.promo_discount_cents, 0) > (quote->>'discount_cents')::integer then
    raise exception 'promo code % is worth % cents, not %',
      new.promo_code, quote->>'discount_cents', new.promo_discount_cents
      using errcode = 'check_violation';
  end if;

  new.promo_code := quote->>'code';
  return new;
end $$;

-- Cashback is earned on what was actually spent: an automatic discount comes
-- out first, the same as a code.
create or replace function public.bonus_earn_on_paid()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  row_json jsonb;
  pct      integer;
  base     integer;
  uid      uuid;
  earned   integer;
begin
  if new.payment_status is distinct from 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.payment_status is not distinct from 'paid' then return new; end if;

  pct := public.referral_setting_int('bonus_cashback_pct', 0);
  if pct <= 0 then return new; end if;

  row_json := to_jsonb(new);
  uid := public.order_user_uuid(row_json);
  if uid is null then return new; end if;

  base := public.order_base_cents(tg_table_name::text, row_json)
          - coalesce((row_json->>'promo_discount_cents')::integer, 0)
          - coalesce((row_json->>'offer_discount_cents')::integer, 0)
          - coalesce(new.credit_applied_cents, 0);
  earned := (greatest(base, 0) * pct) / 100;
  if earned <= 0 then return new; end if;

  begin
    insert into public.user_credits (user_id, amount_cents, reason, order_table, order_id, note)
    values (uid, earned, 'cashback', tg_table_name::text, new.id::text, pct || '% back');
  exception when others then
    raise warning 'cashback failed for %:%: %', tg_table_name, new.id, sqlerrm;
  end;

  return new;
end $function$;

do $$
declare t text;
begin
  foreach t in array array['provider_subscriptions','food_subscriptions','cleaning_subscriptions','rental_bookings'] loop
    execute format('drop trigger if exists discount_guard on public.%I', t);
    execute format('create trigger discount_guard before insert or update of offer_discount_id, offer_discount_cents, promo_discount_cents on public.%I for each row execute function public.discount_guard_on_order()', t);
    -- "stamp_…" sorts after "discount_guard" and "promo_guard": it stamps what they passed.
    execute format('drop trigger if exists stamp_discount_funding on public.%I', t);
    execute format('create trigger stamp_discount_funding before insert or update of offer_discount_id, offer_discount_cents, promo_code, promo_discount_cents on public.%I for each row execute function public.stamp_discount_funding()', t);
    execute format('drop trigger if exists discount_redeem on public.%I', t);
    execute format('create trigger discount_redeem after insert or update of payment_status on public.%I for each row execute function public.discount_redeem_on_paid()', t);
  end loop;
end $$;

-- Orders already paid with a business's own promo code are NOT re-stamped:
-- that money may already be paid out, and taking it back now would surprise
-- the business. From this migration on, its own codes come off its earnings.

-- Admin knobs (Admin → Discounts).
insert into public.global_settings (id, key, value)
select gen_random_uuid()::text, k, v from (values
  ('discount_max_pct',        '70'::jsonb),
  ('discount_max_live',       '5'::jsonb)
) s(k, v)
where not exists (select 1 from public.global_settings g where g.key = s.k);
