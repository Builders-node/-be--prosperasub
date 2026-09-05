-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260805203451 · add_customer_whatsapp_to_cleaning_subscriptions

-- Cleaning never asked for a phone, so a provider had no way to reach the
-- customer about a visit. Named to match food_subscriptions and rental_bookings
-- rather than inventing a third spelling for the same thing.
alter table public.cleaning_subscriptions
  add column if not exists customer_whatsapp text;

comment on column public.cleaning_subscriptions.customer_whatsapp is
  'Contact number captured at checkout. Same meaning and name as food_subscriptions.customer_whatsapp.';
