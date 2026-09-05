-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811222255 · apply_booking_settings_to_published_slots

-- Saving the booking settings now brings the published days into line with
-- them — not just the capacity.
--
-- Blocked ranges were only ever a read-time filter over rows the seeder had
-- already written, so setting a lunch break hid the overlapping slots from the
-- booking page but left the seeded grid untouched: the admin calendar still
-- showed them, and the slot that should follow the break — the engines now
-- resume the day AT its end, with no buffer — did not exist at all.
--
-- Three steps, cheapest first:
--   1. capacity onto every future slot (unchanged behaviour, see the previous
--      migration for the absent-value trap in this function),
--   2. delete future slots that now fall inside a block AND nobody has booked
--      — deleted rather than deactivated so that REMOVING the block brings
--      the hours back on the next save; a deactivated row would stay dead
--      because the seeder only inserts,
--   3. re-seed, which fills in whatever the new shape asks for.
--
-- A full 180-day reseed of one provider measures ~27 ms, so it is affordable
-- on a settings save. The seeder does not write to `providers`, so no recursion.
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_raw    integer;
  v_cap    integer;
  v_today  date := (now() at time zone 'America/Tegucigalpa')::date;
  v_blocks jsonb := coalesce(new.booking_settings->'blockedRanges', '[]'::jsonb);
begin
  -- ── 1. Capacity ─────────────────────────────────────────────────────────
  -- Absence is checked BEFORE clamping: greatest(1, coalesce(x, 0)) is 1, so
  -- the earlier version read "never set" as a capacity of one and halved the
  -- schedule of any provider that had not answered.
  v_raw := nullif(new.booking_settings->>'capacity', '')::int;
  if v_raw is not null and v_raw >= 1 then
    v_cap := v_raw;
    -- Never below what is already booked into that hour. Lowering means "take
    -- no more", not "cancel someone".
    update cleaning_available_slots s
    set max_bookings = greatest(v_cap, coalesce(s.current_bookings, 0)),
        updated_at = now()
    where s.provider_id = new.id
      and s.date >= v_today
      and s.max_bookings is distinct from greatest(v_cap, coalesce(s.current_bookings, 0));
  end if;

  -- ── 2. Drop future slots that a block now covers ────────────────────────
  -- Only ones nobody has booked. A booked hour is a commitment the provider
  -- has already made; the read-time filter hides it from new customers and
  -- the booking itself stays exactly where it is.
  delete from cleaning_available_slots s
  where s.provider_id = new.id
    and s.date >= v_today
    and not exists (select 1 from cleaning_bookings b where b.slot_id = s.id)
    and exists (
      select 1 from jsonb_array_elements(v_blocks) b
      where (nullif(b->>'date', '') is null
             or nullif(b->>'date', '') = to_char(s.date, 'YYYY-MM-DD'))
        and (b->>'from') ~ '^[0-9]{1,2}:[0-9]{2}'
        and (b->>'to')   ~ '^[0-9]{1,2}:[0-9]{2}'
        and s.start_time < nullif(b->>'to', '')::time
        and s.end_time   > nullif(b->>'from', '')::time
    );

  -- ── 3. Fill in whatever the new shape asks for ──────────────────────────
  -- Including the slot that starts the moment a block ends. Only for a
  -- provider that already keeps its own grid; seed_cleaning_slots is given an
  -- explicit id, which is the deliberate opt-in.
  if exists (select 1 from cleaning_available_slots s where s.provider_id = new.id) then
    perform public.seed_cleaning_slots(180, new.id);
  end if;

  return new;
exception when others then
  raise warning 'apply_provider_slot_capacity failed for %: %', new.id, sqlerrm;
  return new;
end;
$function$;
