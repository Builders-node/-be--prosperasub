-- How a customer receives a service — three ways, chosen per offer — and a
-- business's OWN zones on the map.
--
--   self_service — the customer comes to the business (a class, a gym, pickup).
--   on_site      — the business comes to the customer (a cleaner, a mechanic,
--                  a massage at home). The address is a pin; the business's
--                  zones say where it goes and what the call-out costs.
--   delivery     — it is brought (food, goods): by the business's own people
--                  inside its own zones, else by the platform's couriers inside
--                  the platform's zones.
--
--   provider_plans.service_modes        — which of the three an offer allows
--                                         (NULL = not set: the old behaviour,
--                                         read from delivery_mode).
--   provider_subscriptions.service_mode — the one the customer chose.
--   delivery_zones.provider_id          — already there; now businesses draw
--                                         their own (Edge api, owner/team).
--
-- Money: a fee in a PLATFORM zone is the platform's (couriers are ours). A fee
-- in the business's OWN zone is the business's — the earnings readers add it
-- (delivered_by = 'provider'). Neither ever goes into price_cents.
--
-- Safe to run twice.

-- 1. The offer ────────────────────────────────────────────────────────────────
alter table public.provider_plans add column if not exists service_modes text[];
do $$ begin
  alter table public.provider_plans add constraint provider_plans_service_modes_check
    check (service_modes is null or (cardinality(service_modes) >= 1
      and service_modes <@ array['self_service', 'on_site', 'delivery']::text[]));
exception when duplicate_object then null; end $$;

-- What delivery_mode already said, in the new words.
update public.provider_plans
   set service_modes = case delivery_mode
     when 'delivery' then array['delivery']
     when 'both' then array['self_service', 'delivery']
   end
 where service_modes is null and delivery_mode in ('delivery', 'both');

comment on column public.provider_plans.service_modes is
  'How the customer receives it: self_service (comes to the business), on_site (the business comes to them), delivery (brought). NULL = not set; read delivery_mode.';

-- 2. The order ────────────────────────────────────────────────────────────────
alter table public.provider_subscriptions add column if not exists service_mode text;
do $$ begin
  alter table public.provider_subscriptions add constraint provider_subscriptions_service_mode_check
    check (service_mode is null or service_mode in ('self_service', 'on_site', 'delivery'));
exception when duplicate_object then null; end $$;

-- 3. The check, now for all three ─────────────────────────────────────────────
create or replace function public.stamp_order_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  z public.delivery_zones;
  pl record;
  modes text[];
  m text;
  lat double precision;
  lng double precision;
  base integer;
begin
  m := new.service_mode;

  if new.delivery_zone_id is null then
    -- A business that drew zones goes only inside them; one that drew none
    -- goes anywhere (and charges no call-out).
    -- A delivery always lands in some zone (the business's or the platform's).
    if tg_op = 'INSERT' or new.delivery_point is distinct from old.delivery_point
       or new.service_mode is distinct from old.service_mode then
      if m = 'delivery'
         or (m = 'on_site' and exists (select 1 from delivery_zones dz where dz.provider_id = new.provider_id and dz.is_active)) then
        raise exception 'address_outside_zone' using errcode = 'P0001';
      end if;
    end if;
    if tg_op = 'INSERT' or new.delivery_zone_id is distinct from old.delivery_zone_id then
      new.delivery_fee_cents := 0;
    end if;
    if m = 'on_site' and tg_op = 'INSERT' then new.delivered_by := 'provider'; end if;
    return new;
  end if;

  -- An admin or a courier moving a delivery along is not a new claim.
  if tg_op = 'UPDATE'
     and new.delivery_zone_id is not distinct from old.delivery_zone_id
     and new.delivery_point is not distinct from old.delivery_point
     and new.price_cents is not distinct from old.price_cents
     and new.service_mode is not distinct from old.service_mode then
    return new;
  end if;

  select * into z from delivery_zones where id = new.delivery_zone_id;
  if not found or not z.is_active then
    raise exception 'delivery_zone_unavailable' using errcode = 'P0001';
  end if;

  -- The switches live on the OFFER; an order names one of its variants.
  select service_modes, delivery_mode, delivery_zone_ids, delivery_fee_cents, parent_plan_id into pl
    from provider_plans where id = new.plan_id;
  if pl.parent_plan_id is not null and pl.service_modes is null and coalesce(pl.delivery_mode, 'off') = 'off' then
    select service_modes, delivery_mode, delivery_zone_ids, delivery_fee_cents, parent_plan_id into pl
      from provider_plans where id = pl.parent_plan_id;
  end if;
  modes := coalesce(pl.service_modes, case coalesce(pl.delivery_mode, 'off')
    when 'delivery' then array['delivery'] when 'both' then array['self_service', 'delivery'] else array[]::text[] end);

  m := coalesce(m, 'delivery');
  new.service_mode := m;
  if m = 'self_service' or not (m = any (modes)) then
    raise exception 'offer_not_delivered' using errcode = 'P0001';
  end if;

  if z.provider_id is null then
    -- The platform's couriers deliver; they do not clean houses.
    if m <> 'delivery' then raise exception 'zone_not_offered' using errcode = 'P0001'; end if;
    if pl.delivery_zone_ids is not null and not (z.id = any (pl.delivery_zone_ids)) then
      raise exception 'zone_not_offered' using errcode = 'P0001';
    end if;
  elsif z.provider_id is distinct from new.provider_id then
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
  -- A visit is not a parcel: only a delivery has a courier's status.
  new.delivery_status := case when m = 'delivery' then coalesce(new.delivery_status, 'pending') else null end;
  return new;
end;
$$;
revoke all on function public.stamp_order_delivery() from public, anon, authenticated;

comment on column public.provider_subscriptions.service_mode is
  'How this order is received: self_service, on_site or delivery. Checked against the offer and the zone by stamp_order_delivery.';
