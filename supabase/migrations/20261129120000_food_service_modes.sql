-- Food gets the same three ways to receive it as every other offer:
-- self-service (pickup), a visit, or delivery — inside the RESTAURANT's own
-- zones (workspace → Delivery), at the restaurant's own fee.
--
-- A meal plan is bought into food_subscriptions, not provider_subscriptions,
-- so it needs the same columns and its own check. The rules are the ones
-- stamp_order_delivery applies, with two differences:
--
--   * Ids are legacy. food_subscriptions.provider_id is food_providers.id and
--     meal_plan_id is food_meal_plans.id; the switches live on the universal
--     OFFER (provider_plans, source_service_key = 'food'), reached through
--     source_*_id and then the variant's parent.
--   * No platform couriers. Restaurants have always brought their own food;
--     with no zones drawn a delivery goes anywhere with no fee, as before.
--
-- An offer whose service_modes is NULL keeps the old checkout (area + typed
-- address) and nothing here checks it. Safe to run twice.

alter table public.food_subscriptions
  add column if not exists service_mode text,
  add column if not exists delivery_point jsonb,
  add column if not exists delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  add column if not exists delivery_fee_cents integer not null default 0,
  add column if not exists delivered_by text;
do $$ begin
  alter table public.food_subscriptions add constraint food_subscriptions_service_mode_check
    check (service_mode is null or service_mode in ('self_service', 'on_site', 'delivery'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.food_subscriptions add constraint food_subscriptions_delivered_by_check
    check (delivered_by is null or delivered_by in ('platform', 'provider'));
exception when duplicate_object then null; end $$;

comment on column public.food_subscriptions.delivery_fee_cents is
  'Delivery fee on top of the meals, priced from the restaurant''s own zone. The restaurant''s money (delivered_by = provider) — earnings readers add it; never part of weekly_price_cents.';

create or replace function public.stamp_food_order_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  z public.delivery_zones;
  pl record;
  prov uuid;
  m text;
  lat double precision;
  lng double precision;
  base integer;
begin
  m := new.service_mode;
  -- The old checkout (no way chosen) is not ours to judge.
  if m is null then return new; end if;

  -- Nothing that decides the fee moved: a status change, a payment, a renewal.
  if tg_op = 'UPDATE'
     and new.service_mode is not distinct from old.service_mode
     and new.delivery_zone_id is not distinct from old.delivery_zone_id
     and new.delivery_point is not distinct from old.delivery_point
     and new.weekly_price_cents is not distinct from old.weekly_price_cents
     and new.commitment_weeks is not distinct from old.commitment_weeks then
    return new;
  end if;

  select id into prov from providers
   where source_service_key = 'food' and source_provider_id = new.provider_id::text
   limit 1;

  select service_modes, delivery_fee_cents, parent_plan_id into pl
    from provider_plans
   where source_service_key = 'food' and source_plan_id = new.meal_plan_id::text
   limit 1;
  if found and pl.service_modes is null and pl.parent_plan_id is not null then
    select service_modes, delivery_fee_cents, parent_plan_id into pl
      from provider_plans where id = pl.parent_plan_id;
  end if;
  if pl.service_modes is null or not (m = any (pl.service_modes)) then
    raise exception 'offer_not_delivered' using errcode = 'P0001';
  end if;

  if m = 'self_service' then
    new.delivery_zone_id := null;
    new.delivery_point := null;
    new.delivery_fee_cents := 0;
    new.delivered_by := null;
    return new;
  end if;

  new.delivered_by := 'provider';

  if new.delivery_zone_id is null then
    -- A restaurant that drew zones goes only inside them; one that drew none
    -- goes anywhere, free — which is how food has always worked.
    if exists (select 1 from delivery_zones dz where dz.provider_id = prov and dz.is_active) then
      raise exception 'address_outside_zone' using errcode = 'P0001';
    end if;
    new.delivery_fee_cents := 0;
    return new;
  end if;

  select * into z from delivery_zones where id = new.delivery_zone_id;
  if not found or not z.is_active then
    raise exception 'delivery_zone_unavailable' using errcode = 'P0001';
  end if;
  if z.provider_id is distinct from prov then
    raise exception 'zone_not_offered' using errcode = 'P0001';
  end if;

  lat := (new.delivery_point ->> 'lat')::double precision;
  lng := (new.delivery_point ->> 'lng')::double precision;
  if not public.delivery_zone_contains(z, lat, lng) then
    raise exception 'address_outside_zone' using errcode = 'P0001';
  end if;

  base := coalesce(new.weekly_price_cents, 0) * greatest(coalesce(new.commitment_weeks, 1), 1);
  if z.min_order_cents is not null and base < z.min_order_cents then
    raise exception 'below_minimum_order' using errcode = 'P0001';
  end if;

  new.delivery_fee_cents := case
    when z.free_from_cents is not null and base >= z.free_from_cents then 0
    else coalesce(pl.delivery_fee_cents, z.fee_cents, 0)
  end;
  return new;
end;
$$;
revoke all on function public.stamp_food_order_delivery() from public, anon, authenticated;

drop trigger if exists food_subscriptions_stamp_delivery on public.food_subscriptions;
create trigger food_subscriptions_stamp_delivery
  before insert or update on public.food_subscriptions
  for each row execute function public.stamp_food_order_delivery();
