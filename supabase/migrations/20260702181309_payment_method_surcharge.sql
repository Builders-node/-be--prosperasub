-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260702181309 · payment_method_surcharge

alter table public.payment_method_settings
add column if not exists surcharge_percent numeric(6,3) not null default 0;
