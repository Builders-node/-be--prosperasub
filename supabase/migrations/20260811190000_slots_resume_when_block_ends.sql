-- No buffer in front of a blocked hour, and the seeded grid follows the rule.
--
-- The buffer is the gap a provider needs AFTER a job — tidying up, driving to
-- the next address. A blocked hour is not a job, so the day resumes the moment
-- the block ends. Stepping the fixed grid past it instead pushed the first
-- slot after a 12:00–15:00 lunch to 15:30 and quietly cost half an hour of
-- every such day.
--
-- The rule now exists in three places and they must agree, or the customer is
-- offered an hour the provider closed:
--   frontend/src/lib/booking/bookingSettings.ts   latestBlockEnd + computeSlots
--   backend/src/booking/schedule.ts + slot-engine.ts
--   this function
--
-- Cleaning is the service that reads PRE-SEEDED rows rather than generating on
-- the fly, so without this the provider's own preview would have promised an
-- hour no row existed for.
--
-- The inner generation becomes procedural: a set-based grid cannot express
-- "restart the clock here". The outer shape (which providers, which days) is
-- unchanged, and for a provider with no blocked ranges the output is identical
-- — verified by re-running it and finding nothing new to insert.
--
-- Applied to production on 2026-08-11 via the Supabase MCP; the full statement
-- is the CREATE OR REPLACE below.

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
  v_day      date;
  v_cfg      jsonb;
  v_opens    time;
  v_closes   time;
  v_cur      time;
  v_end      time;
  v_blk      time;
  v_step     interval;
  v_dur      interval;
  v_iter     integer;
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

  -- The shared grid, unchanged, still on the global numbers and the four fixed
  -- times. It is the schedule for platform-run cleaning that belongs to no
  -- single provider, so there is nobody whose settings it could read.
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
           greatest(1, coalesce((pr.booking_settings->>'capacity')::int, v_default)) as cap,
           pr.booking_settings->'weekly'                                   as weekly,
           coalesce(pr.booking_settings->'blockedRanges', '[]'::jsonb)     as blocks,
           coalesce(pr.booking_settings->'blockedDates',  '[]'::jsonb)     as blocked_days
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

    v_dur  := (r.dur || ' minutes')::interval;
    v_step := ((r.dur + r.buf) || ' minutes')::interval;

    for v_day in select d::date from generate_series(v_today, v_until, interval '1 day') d loop
      -- weekly is Monday-first; extract(dow) is Sunday-first.
      v_cfg := r.weekly -> (((extract(dow from v_day)::int + 6) % 7));

      if not coalesce((v_cfg->>'enabled')::boolean, false) then continue; end if;
      if r.blocked_days ? to_char(v_day, 'YYYY-MM-DD') then continue; end if;

      v_opens  := nullif(v_cfg->>'from', '')::time;
      v_closes := nullif(v_cfg->>'to',   '')::time;
      if v_opens is null or v_closes is null or v_closes <= v_opens then continue; end if;

      v_cur  := v_opens;
      v_iter := 0;

      while (v_cur + v_dur) <= v_closes loop
        -- Two backstops. A time + interval wraps past midnight, and a range
        -- that fails to advance the clock would spin forever; either way the
        -- nightly cron must not hang.
        v_iter := v_iter + 1;
        if v_iter > 200 or v_cur < v_opens then
          raise warning 'slot generation for provider % on % stopped after % steps', r.id, v_day, v_iter;
          exit;
        end if;

        v_end := v_cur + v_dur;

        -- The end of the latest block this slot runs into. Mirrors
        -- latestBlockEnd() in backend/src/booking/schedule.ts and the
        -- frontend's bookingSettings.ts — three implementations of one rule,
        -- and a disagreement offers an hour the provider closed.
        select max(nullif(b->>'to', '')::time) into v_blk
        from jsonb_array_elements(r.blocks) b
        where (nullif(b->>'date', '') is null
               or nullif(b->>'date', '') = to_char(v_day, 'YYYY-MM-DD'))
          and (b->>'from') ~ '^[0-9]{1,2}:[0-9]{2}'
          and (b->>'to')   ~ '^[0-9]{1,2}:[0-9]{2}'
          and v_cur < nullif(b->>'to', '')::time
          and v_end > nullif(b->>'from', '')::time;

        if v_blk is not null then
          -- Resume AT the block's end, with no buffer in front of it.
          if v_blk > v_cur then v_cur := v_blk; else v_cur := v_cur + v_step; end if;
          continue;
        end if;

        insert into cleaning_available_slots
          (id, date, start_time, end_time, max_bookings, current_bookings, is_active, provider_id)
        values (
          'slot-' || substr(replace(r.id::text, '-', ''), 1, 8) || '-'
            || to_char(v_day, 'YYYY-MM-DD') || '-'
            || replace(to_char(v_cur, 'HH24:MI'), ':', ''),
          v_day, v_cur, v_end, r.cap, 0, true, r.id
        )
        on conflict do nothing;

        get diagnostics v_rows = row_count;
        v_created := v_created + v_rows;

        v_cur := v_cur + v_step;
      end loop;
    end loop;
  end loop;

  return query select v_created, v_today, v_until;
end;
$function$;

revoke all on function public.seed_cleaning_slots(integer, uuid) from public, anon, authenticated;
