-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060750 · unify_b3_occurrence_triggers

drop trigger if exists mirror_occurrence_cleaning on cleaning_bookings;
create trigger mirror_occurrence_cleaning
after insert or update on cleaning_bookings
for each row execute function mirror_legacy_occurrence();

drop trigger if exists mirror_occurrence_beach_court on beach_club_court_bookings;
create trigger mirror_occurrence_beach_court
after insert or update on beach_club_court_bookings
for each row execute function mirror_legacy_occurrence();

drop trigger if exists mirror_occurrence_food_delivery on food_delivery_logs;
create trigger mirror_occurrence_food_delivery
after insert or update on food_delivery_logs
for each row execute function mirror_legacy_occurrence();
