-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811005324 · mirror_plan_trigger_fix_uuid_comparison

-- providers.source_provider_id is uuid, not text. Comparing it to
-- new.provider_id::text raised 42883 and killed the whole food_meal_plans
-- write, so a restaurant editing a meal plan would have got an error instead
-- of a save. Compare uuid to uuid.

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

  elsif TG_TABLE_NAME = 'food_meal_plans' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food' and p.source_provider_id = new.provider_id;
    v_name  := new.name;
    v_desc  := new.description;
    v_price := new.weekly_price_cents;
    v_period := 'weekly';
    v_status := case when new.status = 'active' then 'active' else 'inactive' end;
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
     source_service_key, source_plan_id, updated_at)
  values
    (v_provider, v_name, v_desc, coalesce(v_price, 0), 'USD', v_period, v_status,
     coalesce(v_sort, 0), v_svc, v_source_id, now())
  on conflict (source_service_key, source_plan_id) do update
    set provider_id = excluded.provider_id,
        name        = excluded.name,
        description = excluded.description,
        price_cents = excluded.price_cents,
        period      = excluded.period,
        status      = excluded.status,
        sort_order  = excluded.sort_order,
        updated_at  = now();

  return new;
exception when others then
  -- The mirror must never be the reason a legacy write fails.
  raise warning 'plan mirror failed for %.%: %', TG_TABLE_NAME, new.id, sqlerrm;
  return new;
end;
$function$;
