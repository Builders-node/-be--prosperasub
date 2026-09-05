-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811193626 · provider_slot_capacity

-- Slot capacity becomes the provider's own setting.
--
-- It lived in global_settings.default_slot_capacity — ONE number for the whole
-- platform — so a cleaning company with three crews and a single massage table
-- were both assumed to take the same number of bookings per hour. The provider
-- now sets it in booking_settings.capacity, next to the working hours and
-- session length it already owns.
--
-- The global values stay as the fallback for the legacy shared grid, which
-- belongs to no single provider.

-- ── Seeder ─────────────────────────────────────────────────────────────────
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

  -- The shared grid, unchanged, still on the global numbers. It is the
  -- schedule for platform-run cleaning that belongs to no single provider, so
  -- there is nobody whose capacity it could read.
  if p_provider_id is null then
    with grid as (
      select d::date as slot_date, t.start_time, t.end_time
      from generate_series(v_today, v_until, interval '1 day') d
      cross join (values
        ('08:00:00', '09:45:00'), ('10:00:00', '11:45:00'),
        ('12:00:00', '13:45:00'), ('14:00:00', '15:45:00')
      ) as t(start_time, end_time)
      where extract(dow from d) <> 0   -- 0 = Sunday, nobody rostered
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

  -- Per-provider grids. Without an explicit id this only TOPS UP providers
  -- that already have one: moving a provider off the shared rows is deliberate,
  -- because its live bookings and its capacity live there, and doing it
  -- automatically would put the same hour in two grids with two capacities.
  for r in
    select pr.id,
           coalesce((pr.booking_settings->>'sessionDurationMin')::int, 60) as dur,
           coalesce((pr.booking_settings->>'bufferAfterMin')::int, 0)      as buf,
           -- The provider's own answer to "how many at once". No value means
           -- settings written before the field existed; those keep the global
           -- default, which is what they were generated with.
           greatest(1, coalesce((pr.booking_settings->>'capacity')::int, v_default)) as cap,
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
    -- A non-positive step would loop forever; a bad row is skipped, loudly.
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
      r.cap,
      0, true, r.id
    from grid g
    join open_days o on o.slot_date = g.slot_date
    where g.end_time <= o.closes and g.start_time >= o.opens
      and g.end_time > g.start_time
    on conflict do nothing;

    get diagnostics v_rows = row_count;
    v_created := v_created + v_rows;
  end loop;

  return query select v_created, v_today, v_until;
end;
$function$;

revoke all on function public.seed_cleaning_slots(integer, uuid) from public, anon, authenticated;
