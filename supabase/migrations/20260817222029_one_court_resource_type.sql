-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260817222029 · one_court_resource_type

-- One kind called "Court".
--
-- The picker offered "Tennis court" and "Pickleball" as separate kinds, so the
-- club had to decide what a padel court or a beach-volleyball court was, and
-- the list under each calendar read "Tennis court" where the name already said
-- Tennis Court 1. The kind is about how a thing is booked — an hour on a
-- surface — and that is one kind; what sport it is, is its name.
insert into public.resource_types (key, label, booking_model, metadata_schema, constraints, is_active, sort_order)
values ('court', 'Court', 'time_slot', '{"surface":"string"}'::jsonb, '{}'::jsonb, true, 20)
on conflict (key) do update
  set label = excluded.label,
      booking_model = excluded.booking_model,
      is_active = true,
      sort_order = excluded.sort_order,
      updated_at = now();

-- Everything already booked as tennis or pickleball is a court. Same booking
-- model, so nothing about how they are booked changes.
update public.bookable_resources
set type = 'court', updated_at = now()
where type in ('tennis', 'pickleball');

-- Retired, not deleted: the rows survive so an old reference still resolves to
-- a label, and the picker only lists what is active.
update public.resource_types
set is_active = false, updated_at = now()
where key in ('tennis', 'pickleball');
