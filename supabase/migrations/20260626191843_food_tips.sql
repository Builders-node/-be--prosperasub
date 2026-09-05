-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626191843 · food_tips

create table if not exists public.food_tips (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  provider_id uuid not null references public.food_providers(id) on delete cascade,
  subscription_id uuid references public.food_subscriptions(id) on delete set null,
  customer_name text,
  amount_cents integer not null,
  message text,
  payment_status text not null default 'paid',
  payment_method text,
  payment_reference text,
  created_at timestamptz not null default now()
);
create index if not exists idx_food_tips_provider on public.food_tips (provider_id);
create index if not exists idx_food_tips_subscription on public.food_tips (subscription_id);

alter table public.food_tips enable row level security;
drop policy if exists food_tips_all on public.food_tips;
create policy food_tips_all on public.food_tips for all to public using (true) with check (true);

-- link a review to the specific purchase (optional)
alter table public.food_reviews add column if not exists subscription_id uuid;
