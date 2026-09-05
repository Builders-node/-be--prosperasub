-- Saving the booking settings republishes the provider's future days, so the
-- grid always equals the settings.
--
-- Blocked ranges used to be a read-time filter over rows the seeder had already
-- written. Setting a lunch break hid the overlapping slots from the booking
-- page but left the seeded grid untouched: the admin calendar still showed
-- them, and the slot that should follow the break — the engines resume the day
-- AT its end, with no buffer — did not exist at all.
--
-- Surgical deletion of only the newly-blocked slots was not enough either. The
-- rows the OLD shape had produced survived: a 09:00–10:00 block left a correct
-- 10:00–11:00 sitting immediately beside a stale 11:00–12:00, back to back with
-- none of the 30-minute buffer the provider had asked for.
--
-- So: clear the future days and let the seeder rewrite them. What is NOT
-- cleared is the point:
--   * anything with a booking — a commitment already made,
--   * anything already inactive — someone switched that hour off on purpose,
--     and the unique index (date, start_time, end_time, provider_id) makes the
--     seeder's insert a no-op for it, so the decision survives.
-- Slot ids are deterministic (provider + date + time), so every unchanged hour
-- is rewritten with exactly the id it had.
--
-- A full 180-day reseed of one provider measures ~27 ms, so it is affordable on
-- a settings save. seed_cleaning_slots does not write to `providers`, so there
-- is no recursion.
--
-- Two traps this function has already fallen into, both invisible in review:
--   * greatest(1, coalesce(x, 0)) is 1, so checking for "not set" AFTER
--     clamping never fires — an absent capacity read as one and halved a
--     provider's schedule.
--   * cleaning_available_slots.start_time is TEXT, not TIME. Comparing it to
--     `(b->>'to')::time` raises 42883, which the exception handler below turned
--     into a warning: the migration reported success and the cleanup did
--     nothing. Verify changes here by reading the slot rows back.
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_raw   integer;
  v_cap   integer;
  v_today date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  -- Only for a provider that already keeps its own grid. Moving one off the
  -- shared rows is a deliberate act, not something a settings save should do.
  if not exists (select 1 from cleaning_available_slots s where s.provider_id = new.id) then
    return new;
  end if;

  -- ── 1. Republish the future ─────────────────────────────────────────────
  delete from cleaning_available_slots s
  where s.provider_id = new.id
    and s.date >= v_today
    and s.is_active
    and not exists (select 1 from cleaning_bookings b where b.slot_id = s.id);

  perform public.seed_cleaning_slots(180, new.id);

  -- ── 2. Capacity onto every future slot ──────────────────────────────────
  -- After the reseed, so it also covers the hours that survived it.
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

  return new;
exception when others then
  -- A convenience trigger must never be the reason a provider cannot save
  -- their own settings.
  raise warning 'apply_provider_slot_capacity failed for %: %', new.id, sqlerrm;
  return new;
end;
$function$;

-- Trigger unchanged from 20260811180000; repeated here so this file stands alone.
drop trigger if exists providers_apply_slot_capacity on providers;
create trigger providers_apply_slot_capacity
  after update of booking_settings on providers
  for each row
  when (new.booking_settings is distinct from old.booking_settings)
  execute function public.apply_provider_slot_capacity();
