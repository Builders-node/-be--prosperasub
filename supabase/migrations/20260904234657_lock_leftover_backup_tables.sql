-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260904234657 · lock_leftover_backup_tables

-- Two leftover backup tables were readable with the anon key: RLS was off, so
-- the browser bundle's own credential could read rows that were copied out of
-- cleaning bookings and occurrences (addresses, access instructions). Nothing
-- in the code has ever referenced them.
--
-- RLS on with no policy = service-role only, which is what a backup should be.
-- They are still DROP candidates (see the audit); this makes them safe to
-- leave standing until that decision is made.
ALTER TABLE IF EXISTS _backup_cleaning_bookings_20260901 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS _backup_orphan_occurrences_20260901 ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE _backup_cleaning_bookings_20260901 IS
'Backup taken 2026-09-01. Nothing reads it. Service-role only. Drop once the cleaning-booking work it guarded is settled.';
COMMENT ON TABLE _backup_orphan_occurrences_20260901 IS
'Backup taken 2026-09-01. Nothing reads it. Service-role only. Drop once the occurrence cleanup it guarded is settled.';
