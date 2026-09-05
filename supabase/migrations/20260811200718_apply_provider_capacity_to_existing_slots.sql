-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811200718 · apply_provider_capacity_to_existing_slots

-- Changing the capacity has to reach the days that are already published.
--
-- The seeder only ever inserts (`on conflict do nothing`), so without this a
-- provider could set "3 at a time", see the number saved, and every slot for
-- the next six months would keep the old capacity — the setting would appear
-- to do nothing for half a year.
--
-- Only FUTURE slots. Past ones are the record of what was actually offered.

create or replace function public.apply_provider_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cap integer;
begin
  v_cap := greatest(1, coalesce((new.booking_settings->>'capacity')::int, 0));
  if v_cap = 0 or v_cap is null then
    return new;
  end if;

  -- Never below what is already booked into that hour. Lowering the number
  -- means "take no more", not "cancel someone" — and a slot showing 3 booked
  -- of 1 would read as corrupt in every capacity check on the platform.
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
