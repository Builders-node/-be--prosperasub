-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816052808 · mirror_bookable_resources_to_beach_courts

-- A calendar is authored on `bookable_resources` from now on. The beach's
-- public page, its booking grid and the engine's own fallback still read
-- `beach_club_courts`, so the write is mirrored down — the same direction and
-- the same reasoning as `providers_mirror_profile_to_legacy`.
--
-- One writer per number. The reverse mirror is deliberately absent: two
-- triggers pointing at each other is how the two rows started disagreeing.
create or replace function mirror_resource_to_beach_court()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source_service_key is distinct from 'beach' or new.source_resource_id is null then
    return new;
  end if;

  update beach_club_courts
     set name         = new.name,
         type         = new.type,
         is_active    = (new.status = 'active'),
         sort_order   = new.sort_order,
         open_hour    = coalesce((new.hours ->> 'open_hour')::int, open_hour),
         close_hour   = coalesce((new.hours ->> 'close_hour')::int, close_hour),
         slot_minutes = coalesce((new.hours ->> 'slot_minutes')::int, slot_minutes),
         description  = coalesce(new.metadata ->> 'description', description)
   where id = new.source_resource_id::uuid;

  return new;
end;
$$;

drop trigger if exists bookable_resources_mirror_to_beach on bookable_resources;
create trigger bookable_resources_mirror_to_beach
  after insert or update on bookable_resources
  for each row execute function mirror_resource_to_beach_court();
