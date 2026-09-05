-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810234033 · seed_cleaning_slots_from_provider_settings

-- Builds each provider's grid from its own providers.booking_settings:
-- the enabled weekdays, their from/to window, sessionDurationMin and
-- bufferAfterMin. A provider set to 60 minutes now gets 60-minute slots.
--
-- Providers with no booking_settings are skipped rather than guessed at, so
-- they keep falling back to the shared legacy grid and nothing changes for
-- them silently.
--
-- p_provider_id restricts the run to one provider; NULL does all of them.

create or replace function public.seed_cleaning_slots(
  p_days_ahead integer default 180,
  p_provider_id uuid default null
)
returns table(created integer, seeded_from date, seeded_to date)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today    date;
  v_until    date;
  v_default  integer;
  v_saturday integer;
  v_created  integer := 0;
  v_rows     integer;
  r          record;
begin
  if p_days_ahead is null or p_days_ahead < 1 or p_days_ahead > 730 then
    raise exception 'p_days_ahead must be between 1 and 730, got %', p_days_ahead;
  end if;

  -- Honduras local, not UTC. At 18:00 HN the server is already on tomorrow and
  -- seeding "from tomorrow" would leave a hole for the rest of today.
  v_today := (now() at time zone 'America/Tegucigalpa')::date;
  v_until := v_today + p_days_ahead;

  select coalesce((value #>> '{}')::integer, 2) into v_default
  from global_settings where key = 'default_slot_capacity';
  select coalesce((value #>> '{}')::integer, 2) into v_saturday
  from global_settings where key = 'saturday_slot_capacity';
  v_default  := coalesce(v_default, 2);
  v_saturday := coalesce(v_saturday, 2);

  for r in
    select pr.id,
           coalesce((pr.booking_settings->>'sessionDurationMin')::int, 60) as dur,
           coalesce((pr.booking_settings->>'bufferAfterMin')::int, 0)      as buf,
           pr.booking_settings->'weekly'                                   as weekly
    from providers pr
    where pr.archetype_key = 'cleaning'
      and pr.status = 'active'
      and pr.booking_settings ? 'weekly'
      and jsonb_typeof(pr.booking_settings->'weekly') = 'array'
      and (p_provider_id is null or pr.id = p_provider_id)
  loop
    -- A zero or negative step would loop forever; a bad row is skipped, loudly.
    if r.dur <= 0 or (r.dur + r.buf) <= 0 then
      raise warning 'provider % has a non-positive session duration (% min); skipped', r.id, r.dur;
      continue;
    end if;

    with days as (
      select d::date as slot_date,
             -- weekly is Monday-first; extract(dow) is Sunday-first.
             r.weekly -> (((extract(dow from d)::int + 6) % 7)) as cfg
      from generate_series(v_today, v_until, interval '1 day') d
    ),
    open_days as (
      select slot_date,
             (cfg->>'from')::time as opens,
             (cfg->>'to')::time   as closes
      from days
      where coalesce((cfg->>'enabled')::boolean, false)
        and cfg->>'from' is not null and cfg->>'to' is not null
    ),
    grid as (
      select o.slot_date,
             (o.opens + (n * (r.dur + r.buf) || ' minutes')::interval)::time as start_time,
             (o.opens + (n * (r.dur + r.buf) || ' minutes')::interval
                      + (r.dur || ' minutes')::interval)::time               as end_time
      from open_days o
      -- Enough steps to cover the longest possible day; the filter below trims.
      cross join generate_series(0, 96) as n
    )
    insert into cleaning_available_slots
      (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
    select
      'slot-' || substr(replace(r.id::text, '-', ''), 1, 8) || '-'
        || to_char(g.slot_date, 'YYYY-MM-DD') || '-'
        || replace(to_char(g.start_time, 'HH24:MI'), ':', ''),
      g.slot_date, g.start_time, g.end_time,
      case when extract(dow from g.slot_date) = 6 then v_saturday else v_default end,
      0, true, r.id
    from grid g
    join open_days o on o.slot_date = g.slot_date
    where g.end_time <= o.closes
      and g.start_time >= o.opens
      -- A window that wraps past midnight would generate nonsense.
      and g.end_time > g.start_time
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end loop;

  return query select v_created, v_today, v_until;
end;
$function$;

-- Same lock-down as before: this was callable with the anon key once.
revoke all on function public.seed_cleaning_slots(integer, uuid) from public, anon, authenticated;
