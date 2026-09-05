-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260624205021 · create_food_delivery_logs

create table if not exists public.food_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.food_subscriptions(id) on delete cascade,
  provider_id uuid not null,
  delivery_date date not null,
  status text not null default 'delivered',
  reason text,
  marked_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, delivery_date)
);
create index if not exists idx_food_delivery_logs_provider_date
  on public.food_delivery_logs (provider_id, delivery_date);
