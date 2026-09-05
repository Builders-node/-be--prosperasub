-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260624223458 · food_delivery_logs_marked_by_text

alter table public.food_delivery_logs
  alter column marked_by type text using marked_by::text;
