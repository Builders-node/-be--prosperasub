-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810234746 · seed_cleaning_slots_keep_shared_grid_and_opt_in

-- Two problems with the previous revision, both found by reading the caller:
--
-- 1. The backend cron calls this with p_days_ahead only. That would have given
--    EVERY cleaning provider its own grid, including Apartment Cleaning, whose
--    146 live bookings sit on the shared rows. The same 08:00 hour would then
--    exist twice — shared capacity 2 plus own capacity 2 — and four cleanings
--    could be booked into a slot meant for two.
--
-- 2. Dropping the hard-coded pairs also dropped the SHARED grid's upkeep. Any
--    provider still on it would have silently run out of days, which is the
--    exact outage this function was written to prevent.
--
-- So: the shared grid is still extended, provider grids are only extended once
-- they exist, and opting a provider in is a deliberate call with its id.

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

  v_today := (now() at time zone 'America/Tegucigalpa')::date;
  v_until := v_today + p_days_ahead;

  select coalesce((value #>> '{}')::integer, 2) into v_default
  from global_settings where key = 'default_slot_capacity';
  select coalesce((value #>> '{}')::integer, 2) into v_saturday
  from global_settings where key = 'saturday_slot_capacity';
  v_default  := coalesce(v_default, 2);
  v_saturday := coalesce(v_saturday, 2);

  -- ── The shared grid, unchanged ──────────────────────────────────────────
  -- Still the schedule for any provider without one of its own.
  if p_provider_id is null then
    with grid as (
      select d::date as slot_date, t.start_time, t.end_time
      from generate_series(v_today, v_until, interval '1 day') d
      cross join (values
        ('08:00:00', '09:45:00'),
        ('10:00:00', '11:45:00'),
        ('12:00:00', '13:45:00'),
        ('14:00:00', '15:45:00')
      ) as t(start_time, end_time)
      -- 0 = Sunday. Nobody is rostered, so publishing one would be a promise
      -- the cleaners can't keep.
      where extract(dow from d) <> 0
    )
    insert into cleaning_available_slots
      (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
    select
      'owned-cleaning-slot-' || to_char(g.slot_date, 'YYYY-MM-DD') || '-' ||
        replace(substr(g.start_time, 1, 5), ':', ''),
      g.slot_date, g.start_time, g.end_time,
      case when extract(dow from g.slot_date) = 6 then v_saturday else v_default end,
      0, true, null
    from grid g
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end if;

  -- ── Per-provider grids, from each provider's own booking_settings ───────
  -- Without an explicit id this only TOPS UP providers that already have a
  -- grid. Moving a provider off the shared rows is a deliberate act, because
  -- its live bookings and its capacity live there.
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
      and (
        pr.id = p_provider_id
        or (p_provider_id is null
            and exists (select 1 from cleaning_available_slots s where s.provider_id = pr.id))
      )
  loop
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
      select slot_date, (cfg->>'from')::time as opens, (cfg->>'to')::time as closes
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
      and g.end_time > g.start_time
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end loop;

  return query select v_created, v_today, v_until;
end;
$function$;

revoke all on function public.seed_cleaning_slots(integer, uuid) from public, anon, authenticated;
