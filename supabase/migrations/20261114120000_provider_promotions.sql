-- Paid promotion for a business or one of its offers.
--
-- Two kinds, both written ONLY by the Edge API (service role):
--   boost    — free to switch on; the business pays extra commission
--              (extra_commission_pct) on the orders the placement brought.
--   featured — a fixed slot for a fixed week, paid up front from the payout
--              balance (a provider_payouts row, method 'promotion').
--
-- Attribution is server-side: a click is logged with the viewer's user id
-- (or a browser session id that the next signed-in event claims), and the
-- commission trigger looks for a click by the buyer on that business within
-- seven days. The browser never says "this order came from an ad".

create table if not exists public.provider_promotions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete restrict,
  plan_id uuid references public.provider_plans(id) on delete set null,
  kind text not null check (kind in ('boost', 'featured')),
  -- featured only: where the slot is. 'home' = Discovery, 'service' = the
  -- business's own service listing.
  placement text check (placement in ('home', 'service')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  price_cents integer not null default 0 check (price_cents >= 0),
  extra_commission_pct numeric not null default 0 check (extra_commission_pct >= 0 and extra_commission_pct <= 50),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  payout_id uuid references public.provider_payouts(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'boost' or (placement is not null and ends_at is not null))
);
create index if not exists provider_promotions_live_idx
  on public.provider_promotions (status, kind, placement, starts_at, ends_at);
create index if not exists provider_promotions_provider_idx
  on public.provider_promotions (provider_id, created_at desc);
-- One boost per business (it is a switch, not a purchase).
create unique index if not exists provider_promotions_one_boost
  on public.provider_promotions (provider_id) where kind = 'boost';

alter table public.provider_promotions enable row level security;
comment on table public.provider_promotions is
  'Paid placements. Service-role only (Edge routes/promotions.ts); the storefront reads them through GET /promotions/active.';

create table if not exists public.promotion_events (
  id bigint generated always as identity primary key,
  promotion_id uuid not null references public.provider_promotions(id) on delete cascade,
  provider_id uuid not null,
  kind text not null check (kind in ('impression', 'click')),
  session_id text,
  user_id text,
  created_at timestamptz not null default now()
);
create index if not exists promotion_events_attr_idx
  on public.promotion_events (user_id, provider_id, created_at desc) where kind = 'click';
create index if not exists promotion_events_stats_idx
  on public.promotion_events (promotion_id, kind, created_at);
create index if not exists promotion_events_session_idx
  on public.promotion_events (session_id) where user_id is null;
alter table public.promotion_events enable row level security;
comment on table public.promotion_events is
  'Impressions and clicks on paid placements. Service-role only.';

-- Which promotion brought an order (stamped by the trigger, never by a writer).
alter table public.provider_subscriptions add column if not exists promotion_id uuid;
alter table public.food_subscriptions     add column if not exists promotion_id uuid;
alter table public.cleaning_subscriptions add column if not exists promotion_id uuid;
alter table public.rental_bookings        add column if not exists promotion_id uuid;

-- The click (if any) that brought this buyer to this business in the last week.
create or replace function public.order_promotion(p_provider uuid, p_user text)
returns table (promotion_id uuid, extra_pct numeric)
language sql stable security definer set search_path to 'public'
as $$
  select p.id, case when p.kind = 'boost' then p.extra_commission_pct else 0 end
    from public.promotion_events e
    join public.provider_promotions p on p.id = e.promotion_id
   where p_provider is not null and p_user is not null
     and e.kind = 'click' and e.user_id = p_user and e.provider_id = p_provider
     and e.created_at > now() - interval '7 days'
   order by e.created_at desc
   limit 1
$$;
revoke execute on function public.order_promotion(uuid, text) from public, anon, authenticated;

create or replace function public.stamp_order_commission()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  j jsonb := to_jsonb(new);
  prov uuid;
  promo record;
begin
  prov := public.order_universal_provider(tg_table_name, j);
  new.commission_pct := public.order_commission_pct(prov, j->>'user_id');
  begin
    select * into promo from public.order_promotion(prov, j->>'user_id');
    if promo.promotion_id is not null then
      new.promotion_id := promo.promotion_id;
      -- The business's own client pays 0% — an ad did not bring them.
      if coalesce(new.commission_pct, 1) > 0 and promo.extra_pct > 0 then
        new.commission_pct := coalesce(new.commission_pct,
          (select commission_pct from public.providers where id = prov), 10) + promo.extra_pct;
      end if;
    end if;
  exception when others then null;  -- attribution never blocks an order
  end;
  return new;
exception when others then
  -- Never block an order over bookkeeping: NULL reads as the provider's rate.
  new.commission_pct := null;
  return new;
end $function$;

-- Prices and slots, editable on the admin Promotions page.
insert into public.global_settings (id, key, value)
select gen_random_uuid()::text, k, v from (values
  ('promo_featured_home_week_cents',    '2500'::jsonb),
  ('promo_featured_service_week_cents', '1500'::jsonb),
  ('promo_boost_extra_pct',             '5'::jsonb),
  ('promo_slots_home',                  '3'::jsonb),
  ('promo_slots_service',               '2'::jsonb)
) s(k, v)
where not exists (select 1 from public.global_settings g where g.key = s.k);
