-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626025557 · food_subscriptions_batch_id

alter table public.food_subscriptions
  add column if not exists batch_id uuid;
create index if not exists idx_food_subscriptions_batch on public.food_subscriptions (batch_id);
