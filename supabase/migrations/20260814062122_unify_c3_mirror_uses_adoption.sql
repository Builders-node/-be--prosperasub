-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814062122 · unify_c3_mirror_uses_adoption

create or replace function mirror_legacy_occurrence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider uuid; v_svc text; v_resource uuid; v_sub text;
  v_user_raw text; v_user uuid;
  v_start timestamptz; v_end timestamptz;
  v_status text; v_item text; v_assignee text; v_notes text; v_access text;
  v_gcal_id text; v_gcal_stat text; v_slot text; v_existing uuid;
begin
  if TG_TABLE_NAME = 'cleaning_bookings' then
    v_svc := 'cleaning';
    v_provider := mirror_cleaning_provider_of(new);
    select (s.date::timestamp + s.start_time::time) at time zone 'America/Tegucigalpa',
           (s.date::timestamp + s.end_time::time)   at time zone 'America/Tegucigalpa'
      into v_start, v_end
      from cleaning_available_slots s where s.id = new.slot_id;
    v_status := case lower(coalesce(new.status, ''))
                  when 'completed' then 'done' when 'cancelled' then 'cancelled'
                  when 'canceled' then 'cancelled' when 'no_show' then 'failed'
                  else 'scheduled' end;
    v_sub := coalesce(new.cleaning_subscription_id, new.subscription_id)::text;
    v_user_raw := new.user_id; v_assignee := new.assigned_cleaner;
    v_notes := new.notes; v_access := new.access_instructions;
    v_gcal_id := new.google_calendar_event_id; v_gcal_stat := new.google_calendar_sync_status;
    v_slot := new.slot_id::text;

  elsif TG_TABLE_NAME = 'beach_club_court_bookings' then
    v_svc := 'beach';
    select p.id into v_provider from providers p where p.source_service_key = 'beach' limit 1;
    select r.id into v_resource from bookable_resources r
     where r.source_service_key = 'beach' and r.source_resource_id::text = new.court_id::text;
    v_start := (new.date::timestamp + make_interval(hours => new.start_hour)) at time zone 'America/Tegucigalpa';
    v_end   := (new.date::timestamp + make_interval(hours => new.end_hour))   at time zone 'America/Tegucigalpa';
    v_status := case lower(coalesce(new.status, ''))
                  when 'cancelled' then 'cancelled' when 'canceled' then 'cancelled'
                  when 'completed' then 'done' else 'scheduled' end;
    v_user_raw := new.user_id; v_notes := new.notes;
    v_gcal_id := new.google_calendar_event_id; v_gcal_stat := new.google_calendar_sync_status;

  elsif TG_TABLE_NAME = 'food_delivery_logs' then
    v_svc := 'food';
    select p.id into v_provider from providers p
     where p.source_service_key = 'food' and p.source_provider_id::text = new.provider_id::text;
    v_start := (new.delivery_date::timestamp) at time zone 'America/Tegucigalpa';
    v_status := case lower(coalesce(new.status, ''))
                  when 'delivered' then 'done' when 'failed' then 'failed'
                  when 'skipped' then 'failed' when 'cancelled' then 'cancelled'
                  else 'scheduled' end;
    v_item := new.meal_type; v_sub := new.subscription_id::text; v_notes := new.reason;
    select f.user_id into v_user_raw from food_subscriptions f where f.id = new.subscription_id;
  else
    return new;
  end if;

  if v_provider is null or v_start is null then return new; end if;

  v_user := case when v_user_raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then v_user_raw::uuid else null end;

  -- Its own row if it has one; otherwise the generated occurrence for the same
  -- subscription, day and meal, which it adopts.
  v_existing := mirror_find_occurrence(v_svc, new.id::text, v_item, v_sub, v_start);

  if v_existing is not null then
    update service_occurrences set
      provider_id = v_provider, resource_id = v_resource, user_id = coalesce(v_user, user_id),
      source_record_id = new.id::text, source_subscription_id = v_sub,
      starts_at = v_start, ends_at = coalesce(v_end, ends_at), slot_id = coalesce(v_slot, slot_id),
      status = v_status, assignee = coalesce(v_assignee, assignee),
      notes = coalesce(v_notes, notes), access_instructions = coalesce(v_access, access_instructions),
      google_calendar_event_id = coalesce(v_gcal_id, google_calendar_event_id),
      google_calendar_sync_status = coalesce(v_gcal_stat, google_calendar_sync_status),
      updated_at = now()
    where id = v_existing;
  else
    insert into service_occurrences
      (provider_id, resource_id, user_id, item_key, starts_at, ends_at, slot_id,
       status, assignee, notes, access_instructions,
       google_calendar_event_id, google_calendar_sync_status,
       source_service_key, source_record_id, source_subscription_id)
    values
      (v_provider, v_resource, v_user, v_item, v_start, v_end, v_slot,
       v_status, v_assignee, v_notes, v_access, v_gcal_id, v_gcal_stat,
       v_svc, new.id::text, v_sub);
  end if;

  return new;
exception when others then
  raise warning 'occurrence mirror failed for %.%: %', TG_TABLE_NAME, new.id, sqlerrm;
  return new;
end;
$$;
