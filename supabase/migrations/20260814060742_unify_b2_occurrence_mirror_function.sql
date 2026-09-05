-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060742 · unify_b2_occurrence_mirror_function

-- Phase B: every legacy occurrence also becomes a `service_occurrences` row.
--
-- Done with a trigger rather than in the app on purpose. The writers are
-- scattered — the browser with the anon key, NestJS with the service role, an
-- RPC shim, an admin dialog — and a dual-write added at each of them drifts
-- the first time somebody adds a fifth. One trigger cannot be forgotten.
--
-- Legacy is still the source of truth. Nothing reads this table yet.
create or replace function mirror_legacy_occurrence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider   uuid;
  v_svc        text;
  v_resource   uuid;
  v_sub        text;
  v_start      timestamptz;
  v_end        timestamptz;
  v_status     text;
  v_item       text;
  v_assignee   text;
  v_notes      text;
  v_access     text;
  v_gcal_id    text;
  v_gcal_stat  text;
  v_existing   uuid;
begin
  if TG_TABLE_NAME = 'cleaning_bookings' then
    v_svc := 'cleaning';
    -- `provider_id` here is the LEGACY cleaning_providers id — bridge it.
    select p.id into v_provider from providers p
     where p.source_service_key = 'cleaning'
       and p.source_provider_id::text = new.provider_id::text;
    select (s.date::timestamp + s.start_time) at time zone 'America/Tegucigalpa',
           (s.date::timestamp + s.end_time)   at time zone 'America/Tegucigalpa'
      into v_start, v_end
      from cleaning_available_slots s where s.id = new.slot_id;
    v_status := case lower(coalesce(new.status, ''))
                  when 'completed' then 'done'
                  when 'cancelled' then 'cancelled'
                  when 'canceled'  then 'cancelled'
                  when 'no_show'   then 'failed'
                  else 'scheduled' end;
    v_sub      := coalesce(new.cleaning_subscription_id, new.subscription_id)::text;
    v_assignee := new.assigned_cleaner;
    v_notes    := new.notes;
    v_access   := new.access_instructions;
    v_gcal_id  := new.google_calendar_event_id;
    v_gcal_stat:= new.google_calendar_sync_status;

  elsif TG_TABLE_NAME = 'beach_club_court_bookings' then
    v_svc := 'beach';
    select p.id into v_provider from providers p where p.source_service_key = 'beach' limit 1;
    select r.id into v_resource from bookable_resources r
     where r.source_service_key = 'beach' and r.source_resource_id::text = new.court_id::text;
    v_start := (new.date::timestamp + make_interval(hours => new.start_hour)) at time zone 'America/Tegucigalpa';
    v_end   := (new.date::timestamp + make_interval(hours => new.end_hour))   at time zone 'America/Tegucigalpa';
    v_status := case lower(coalesce(new.status, ''))
                  when 'cancelled' then 'cancelled'
                  when 'canceled'  then 'cancelled'
                  when 'completed' then 'done'
                  else 'scheduled' end;
    v_notes    := new.notes;
    v_gcal_id  := new.google_calendar_event_id;
    v_gcal_stat:= new.google_calendar_sync_status;

  elsif TG_TABLE_NAME = 'food_delivery_logs' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food'
       and p.source_provider_id::text = new.provider_id::text;
    -- A delivery has a date, not an hour: the promised window lives on the
    -- plan (`lead_time_minutes` / `window_minutes`) and is applied in phase C.
    v_start := (new.delivery_date::timestamp) at time zone 'America/Tegucigalpa';
    v_end   := null;
    v_status := case lower(coalesce(new.status, ''))
                  when 'delivered' then 'done'
                  when 'failed'    then 'failed'
                  when 'skipped'   then 'failed'
                  when 'cancelled' then 'cancelled'
                  else 'scheduled' end;
    v_item   := new.meal_type;
    v_sub    := new.subscription_id::text;
    v_notes  := new.reason;
  else
    return new;
  end if;

  if v_provider is null then
    -- Nothing to attach it to. Skipping beats filing an occurrence under the
    -- wrong business; the backfill can pick it up once the bridge exists.
    return new;
  end if;

  select o.id into v_existing from service_occurrences o
   where o.source_service_key = v_svc
     and o.source_record_id = new.id::text
     and coalesce(o.item_key, '') = coalesce(v_item, '');

  if v_existing is not null then
    update service_occurrences set
      provider_id = v_provider, resource_id = v_resource,
      source_subscription_id = v_sub,
      starts_at = coalesce(v_start, starts_at), ends_at = v_end,
      status = v_status, assignee = v_assignee, notes = v_notes,
      access_instructions = v_access,
      google_calendar_event_id = v_gcal_id, google_calendar_sync_status = v_gcal_stat,
      updated_at = now()
    where id = v_existing;
  elsif v_start is not null then
    insert into service_occurrences
      (provider_id, resource_id, user_id, item_key, starts_at, ends_at, slot_id,
       status, assignee, notes, access_instructions,
       google_calendar_event_id, google_calendar_sync_status,
       source_service_key, source_record_id, source_subscription_id)
    values
      (v_provider, v_resource, new.user_id, v_item, v_start, v_end,
       case when TG_TABLE_NAME = 'cleaning_bookings' then new.slot_id else null end,
       v_status, v_assignee, v_notes, v_access, v_gcal_id, v_gcal_stat,
       v_svc, new.id::text, v_sub);
  end if;

  return new;
exception when others then
  -- The mirror must never be the reason a real booking fails to save.
  raise warning 'occurrence mirror failed for %.%: %', TG_TABLE_NAME, new.id, sqlerrm;
  return new;
end;
$$;
