-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260815223316 · mirror_plan_visibility

-- Carry a legacy plan's visibility across to its mirror.
--
-- Cleaning's two private packages mirrored into `provider_plans` as public,
-- because the mirror never knew the column existed. Anything reading the
-- universal table for a storefront would therefore have listed them — the one
-- thing "private" is for.
--
-- Only cleaning has the column; food and beach have no notion of an unlisted
-- plan, so they mirror as public, which is what they are.
create or replace function public.mirror_plan_to_provider_plans()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_provider   uuid;
  v_svc        text;
  v_name       text;
  v_desc       text;
  v_price      integer;
  v_period     text;
  v_status     text;
  v_sort       integer;
  v_source_id  text;
  v_visibility text := 'public';
begin
  if TG_TABLE_NAME = 'cleaning_packages' then
    v_svc := 'cleaning';
    v_provider := new.owner_provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    -- A cleaning package is priced either per month or per cleaning.
    v_price := coalesce(new.monthly_price_cents,
                        new.price_per_cleaning_cents * coalesce(new.cleanings_per_month, 1));
    v_period := 'monthly';
    -- Four separate flags decide whether it is on sale; any one off means no.
    v_status := case when coalesce(new.is_active, true)
                      and coalesce(new.status, 'active') = 'active'
                      and new.deleted_at is null
                     then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;
    v_visibility := case when coalesce(new.visibility, 'public') = 'private'
                         then 'private' else 'public' end;

  elsif TG_TABLE_NAME = 'food_meal_plans' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food' and p.source_provider_id = new.provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    v_price := new.weekly_price_cents;
    v_period := 'weekly';
    v_status := case when coalesce(new.status, 'active') = 'active' then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;

  elsif TG_TABLE_NAME = 'beach_club_plans' then
    v_svc := 'beach';
    v_provider := new.owner_provider_id;
    v_name  := new.name;
    v_desc  := new.tagline;
    v_price := new.price_per_person_cents;
    v_period := 'monthly';
    v_status := case when coalesce(new.is_active, true) then 'active' else 'inactive' end;
    v_sort := new.sort_order;
    v_source_id := new.id::text;
  else
    return new;
  end if;

  -- No provider means nothing to attach the mirror to. Skip rather than guess:
  -- a row filed under the wrong business is worse than a missing one. And
  -- never fail the caller's write — the mirror is a convenience, and taking a
  -- restaurant's menu edit down with it would be a poor trade.
  if v_provider is null then
    return new;
  end if;

  insert into provider_plans
    (provider_id, name, description, price_cents, currency, period, status, sort_order,
     source_service_key, source_plan_id, visibility, updated_at)
  values
    (v_provider, v_name, v_desc, coalesce(v_price, 0), 'USD', v_period, v_status,
     coalesce(v_sort, 0), v_svc, v_source_id, v_visibility, now())
  on conflict (source_service_key, source_plan_id) do update
    set provider_id = excluded.provider_id,
        name        = excluded.name,
        description = excluded.description,
        price_cents = excluded.price_cents,
        period      = excluded.period,
        status      = excluded.status,
        sort_order  = excluded.sort_order,
        visibility  = excluded.visibility,
        updated_at  = now();

  return new;
exception when others then
  -- The mirror must never be the reason a legacy write fails.
  raise warning 'plan mirror failed for %.%: %', TG_TABLE_NAME, new.id, sqlerrm;
  return new;
end;
$function$;

-- Backfill what the old mirror got wrong.
update public.provider_plans p
   set visibility = c.visibility, updated_at = now()
  from public.cleaning_packages c
 where p.source_service_key = 'cleaning'
   and p.source_plan_id = c.id::text
   and coalesce(c.visibility, 'public') is distinct from p.visibility;
