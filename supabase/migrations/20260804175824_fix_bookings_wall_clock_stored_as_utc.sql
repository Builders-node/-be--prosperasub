-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260804175824 · fix_bookings_wall_clock_stored_as_utc

-- Every booking was written by `new Date("<date>T<time>:00")`, which parses in
-- the process timezone — UTC on Vercel. So an 18:00 Honduras slot was stored as
-- 18:00Z (= 12:00 Honduras) while its own slot_key said 18:00. The customer
-- tapped one time and got a booking six hours away.
--
-- Reinterpret the stored naive wall clock as Honduras local, which is what it
-- always meant. Guarded by the same predicate that identifies a mis-written
-- row, so re-running this is a no-op and a corrected row can't be shifted twice.
update bookings
set start_at = (start_at at time zone 'UTC') at time zone 'America/Tegucigalpa',
    end_at   = (end_at   at time zone 'UTC') at time zone 'America/Tegucigalpa'
where slot_key is not null
  and to_char(start_at at time zone 'UTC', 'HH24:MI') = split_part(slot_key, '|', 3);
