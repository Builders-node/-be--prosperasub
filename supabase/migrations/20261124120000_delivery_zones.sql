-- Delivery: zones on the map, a switch on each offer, and a delivery on each order.
--
--   delivery_zones   — an area (a drawn polygon, or a circle of N km) with its
--                      price, free-from threshold, minimum order and a promised
--                      time ("30–60 min"). provider_id NULL = the PLATFORM's
--                      zone, delivered by platform couriers; the fee is the
--                      platform's money, not the business's revenue.
--   provider_plans   — delivery_mode (off | delivery | both = pickup or
--                      delivery), which zones (NULL = every active platform
--                      zone) and an optional fee for this offer alone.
--   provider_subscriptions — where it goes (delivery_point), which zone, the
--                      fee, who delivers it, its courier and its status.
--   couriers         — the platform's people (assignments come next).
--
-- The fee lives in its OWN column, never in price_cents: earnings and payouts
-- read price_cents, so a delivery fee can never reach a business's balance
-- (the same rule as surcharge_cents).
--
-- The browser writes the order row (PlanCheckout), so the row's claim is
-- re-checked here: the zone must be active, offered by the plan, contain the
-- point, and the fee is recomputed from the zone — whatever the page sent.

-- 1. Zones ────────────────────────────────────────────────────────────────────
create table if not exists public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references public.providers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  shape text not null check (shape in ('polygon', 'circle')),
  -- polygon: [[lng, lat], …] — one outer ring, not closed (the first point is not repeated)
  polygon jsonb,
  center_lat double precision,
  center_lng double precision,
  radius_m integer check (radius_m is null or radius_m between 100 and 100000),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  free_from_cents integer check (free_from_cents is null or free_from_cents >= 0),
  min_order_cents integer check (min_order_cents is null or min_order_cents >= 0),
  eta_min_minutes integer check (eta_min_minutes is null or eta_min_minutes >= 0),
  eta_max_minutes integer check (eta_max_minutes is null or eta_max_minutes >= 0),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_zones_geometry check (
    (shape = 'polygon' and jsonb_typeof(polygon) = 'array' and jsonb_array_length(polygon) >= 3)
    or (shape = 'circle' and center_lat is not null and center_lng is not null and radius_m is not null)
  )
);
create index if not exists delivery_zones_provider_idx on public.delivery_zones (provider_id, sort_order);

alter table public.delivery_zones enable row level security;
-- Anyone may see where delivery goes (the map, the product page); only the
-- Edge api (service role) writes.
drop policy if exists delivery_zones_read on public.delivery_zones;
create policy delivery_zones_read on public.delivery_zones for select to public using (is_active);
revoke insert, update, delete on public.delivery_zones from anon, authenticated;

-- 2. The offer ────────────────────────────────────────────────────────────────
alter table public.provider_plans
  add column if not exists delivery_mode text not null default 'off',
  add column if not exists delivery_zone_ids uuid[],
  add column if not exists delivery_fee_cents integer;
do $$ begin
  alter table public.provider_plans add constraint provider_plans_delivery_mode_check
    check (delivery_mode in ('off', 'delivery', 'both'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.provider_plans add constraint provider_plans_delivery_fee_check
    check (delivery_fee_cents is null or delivery_fee_cents >= 0);
exception when duplicate_object then null; end $$;

-- 3. Couriers ─────────────────────────────────────────────────────────────────
create table if not exists public.couriers (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  name text not null check (char_length(name) between 1 and 80),
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.couriers enable row level security;
revoke all on public.couriers from anon, authenticated;

-- 4. The order ────────────────────────────────────────────────────────────────
alter table public.provider_subscriptions
  add column if not exists delivery_point jsonb,
  add column if not exists delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  add column if not exists delivery_fee_cents integer not null default 0,
  add column if not exists delivered_by text,
  add column if not exists courier_id uuid references public.couriers(id) on delete set null,
  add column if not exists delivery_status text,
  add column if not exists delivered_at timestamptz;
do $$ begin
  alter table public.provider_subscriptions add constraint provider_subscriptions_delivered_by_check
    check (delivered_by is null or delivered_by in ('platform', 'provider'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.provider_subscriptions add constraint provider_subscriptions_delivery_status_check
    check (delivery_status is null or delivery_status in ('pending', 'assigned', 'on_the_way', 'delivered', 'failed'));
exception when duplicate_object then null; end $$;
create index if not exists provider_subscriptions_delivery_idx
  on public.provider_subscriptions (delivery_status, start_date) where delivery_zone_id is not null;

comment on column public.provider_subscriptions.delivery_fee_cents is
  'Delivery fee charged on top of the price — the PLATFORM''s money while platform couriers deliver. Never part of price_cents, never in a payout.';

-- 5. Geometry ─────────────────────────────────────────────────────────────────
-- Is (lat, lng) inside the zone? Ray casting for a polygon, haversine for a circle.
create or replace function public.delivery_zone_contains(z public.delivery_zones, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql
immutable
set search_path to ''
as $$
declare
  n int;
  i int;
  j int;
  xi double precision; yi double precision;
  xj double precision; yj double precision;
  inside boolean := false;
  d double precision;
begin
  if p_lat is null or p_lng is null then return false; end if;
  if z.shape = 'circle' then
    d := 2 * 6371000 * asin(sqrt(
      power(sin(radians(p_lat - z.center_lat) / 2), 2)
      + cos(radians(z.center_lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - z.center_lng) / 2), 2)
    ));
    return d <= z.radius_m;
  end if;
  n := jsonb_array_length(z.polygon);
  if n < 3 then return false; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    xi := (z.polygon -> i ->> 0)::double precision; yi := (z.polygon -> i ->> 1)::double precision;
    xj := (z.polygon -> j ->> 0)::double precision; yj := (z.polygon -> j ->> 1)::double precision;
    if ((yi > p_lat) <> (yj > p_lat))
       and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end;
$$;

-- 6. The order's delivery, checked and priced by the database ────────────────
create or replace function public.stamp_order_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  z public.delivery_zones;
  pl record;
  lat double precision;
  lng double precision;
  base integer;
begin
  if new.delivery_zone_id is null then
    -- No delivery (pickup, or an offer that is not delivered): no fee.
    if tg_op = 'INSERT' or new.delivery_zone_id is distinct from old.delivery_zone_id then
      new.delivery_fee_cents := 0;
    end if;
    return new;
  end if;
  -- An admin moving a delivery along (status, courier) is not a new claim.
  if tg_op = 'UPDATE'
     and new.delivery_zone_id is not distinct from old.delivery_zone_id
     and new.delivery_point is not distinct from old.delivery_point
     and new.price_cents is not distinct from old.price_cents then
    return new;
  end if;

  select * into z from delivery_zones where id = new.delivery_zone_id;
  if not found or not z.is_active then
    raise exception 'delivery_zone_unavailable' using errcode = 'P0001';
  end if;

  -- The switches live on the OFFER; an order names one of its variants.
  select delivery_mode, delivery_zone_ids, delivery_fee_cents, parent_plan_id into pl
    from provider_plans where id = new.plan_id;
  if pl.parent_plan_id is not null and coalesce(pl.delivery_mode, 'off') = 'off' then
    select delivery_mode, delivery_zone_ids, delivery_fee_cents, parent_plan_id into pl
      from provider_plans where id = pl.parent_plan_id;
  end if;
  if pl is null or coalesce(pl.delivery_mode, 'off') = 'off' then
    raise exception 'offer_not_delivered' using errcode = 'P0001';
  end if;
  if pl.delivery_zone_ids is not null and not (z.id = any (pl.delivery_zone_ids)) then
    raise exception 'zone_not_offered' using errcode = 'P0001';
  end if;
  -- Until businesses run their own couriers, an offer is delivered through the
  -- platform's zones only.
  if z.provider_id is not null and z.provider_id is distinct from new.provider_id then
    raise exception 'zone_not_offered' using errcode = 'P0001';
  end if;

  lat := (new.delivery_point ->> 'lat')::double precision;
  lng := (new.delivery_point ->> 'lng')::double precision;
  if not public.delivery_zone_contains(z, lat, lng) then
    raise exception 'address_outside_zone' using errcode = 'P0001';
  end if;

  base := coalesce(new.price_cents, 0);
  if z.min_order_cents is not null and base < z.min_order_cents then
    raise exception 'below_minimum_order' using errcode = 'P0001';
  end if;

  new.delivery_fee_cents := case
    when z.free_from_cents is not null and base >= z.free_from_cents then 0
    else coalesce(pl.delivery_fee_cents, z.fee_cents, 0)
  end;
  new.delivered_by := case when z.provider_id is null then 'platform' else 'provider' end;
  new.delivery_status := coalesce(new.delivery_status, 'pending');
  return new;
end;
$$;
revoke all on function public.stamp_order_delivery() from public, anon, authenticated;

drop trigger if exists provider_subscriptions_stamp_delivery on public.provider_subscriptions;
create trigger provider_subscriptions_stamp_delivery
  before insert or update on public.provider_subscriptions
  for each row execute function public.stamp_order_delivery();

comment on table public.delivery_zones is
  'Where things are delivered: a polygon or a circle with a fee, free-from, minimum and promised time. provider_id NULL = platform couriers (the fee is the platform''s). Read: public (active). Write: Edge api only.';
