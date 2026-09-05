-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260627221647 · cleaning_subscriptions_nullable_package_id

ALTER TABLE public.cleaning_subscriptions ALTER COLUMN package_id DROP NOT NULL;
