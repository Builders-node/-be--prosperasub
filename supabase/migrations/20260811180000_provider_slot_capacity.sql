-- Slot capacity becomes the provider's own setting.
--
-- It lived in global_settings.default_slot_capacity — ONE number for the whole
-- platform — so a cleaning company with three crews and a single massage table
-- were both assumed to take the same number of bookings per hour. The provider
-- now sets it in providers.booking_settings.capacity, next to the working hours
-- and session length it already owns.
--
-- The global values stay as the fallback for the legacy shared grid, which
-- belongs to no single provider, and for a provider that has never set one.
--
-- Two parts:
--   1. seed_cleaning_slots() generates new days at the provider's number.
--   2. A trigger applies a change to the days already published — without it a
--      provider could set "3 at a time", see it saved, and nothing would change
--      for six months, because the seeder only ever inserts.
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.
-- Verified end to end: setting 3 in the provider workspace moved all 470 of
-- Car Wash's future slots to 3, and setting it back moved them to 2.

-- ── 1. Seeder ──────────────────────────────────────────────────────────────
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

-- ── 2. Apply a change to the days already published ────────────────────────
--
-- NOTE the order of the two checks below. The first version read
--     v_cap := greatest(1, coalesce((new.booking_settings->>'capacity')::int, 0));
--     if v_cap = 0 then return new; end if;
-- and greatest(1, 0) is 1 — so "not set" read as a capacity of ONE and any
-- edit to booking_settings silently halved the schedule of a provider that had
-- never touched the field. Check for absence first, then clamp.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_raw integer;
  v_cap integer;
begin
  v_raw := nullif(new.booking_settings->>'capacity', '')::int;

  -- Not set: this provider has never answered the question, so its slots keep
  -- whatever they were generated with (the global default). Doing anything
  -- else here means an edit to the working hours rewrites capacity too.
  if v_raw is null or v_raw < 1 then
    return new;
  end if;
  v_cap := v_raw;

  -- Never below what is already booked into that hour. Lowering the number
  -- means "take no more", not "cancel someone" — and a slot showing 3 booked
  -- of 1 would read as corrupt in every capacity check on the platform.
  -- Only FUTURE slots; past ones record what was actually offered.
  update cleaning_available_slots s
  set max_bookings = greatest(v_cap, coalesce(s.current_bookings, 0)),
      updated_at = now()
  where s.provider_id = new.id
    and s.date >= (now() at time zone 'America/Tegucigalpa')::date
    and s.max_bookings is distinct from greatest(v_cap, coalesce(s.current_bookings, 0));

  return new;
exception when others then
  raise warning 'apply_provider_slot_capacity failed for %: %', new.id, sqlerrm;
  return new;
end;
$function$;

drop trigger if exists providers_apply_slot_capacity on providers;
create trigger providers_apply_slot_capacity
  after update of booking_settings on providers
  for each row
  when (new.booking_settings is distinct from old.booking_settings)
  execute function public.apply_provider_slot_capacity();
