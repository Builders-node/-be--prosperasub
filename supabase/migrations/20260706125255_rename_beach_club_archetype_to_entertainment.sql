-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260706125255 · rename_beach_club_archetype_to_entertainment

UPDATE service_archetypes SET key = 'entertainment' WHERE key = 'beach_club';
