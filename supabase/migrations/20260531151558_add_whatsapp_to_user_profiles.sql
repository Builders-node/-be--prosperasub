-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260531151558 · add_whatsapp_to_user_profiles

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS whatsapp TEXT;
