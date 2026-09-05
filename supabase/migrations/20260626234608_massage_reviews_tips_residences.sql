-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626234608 · massage_reviews_tips_residences

create table if not exists public.massage_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  booking_id uuid not null,
  provider_id uuid,
  customer_name text,
  rating integer not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, user_id)
);
alter table public.massage_reviews enable row level security;
drop policy if exists massage_reviews_all on public.massage_reviews;
create policy massage_reviews_all on public.massage_reviews for all to public using (true) with check (true);

create table if not exists public.massage_tips (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  booking_id uuid not null,
  provider_id uuid,
  customer_name text,
  amount_cents integer not null,
  message text,
  payment_status text not null default 'paid',
  payment_method text,
  payment_reference text,
  created_at timestamptz not null default now()
);
create index if not exists idx_massage_tips_booking on public.massage_tips (booking_id);
alter table public.massage_tips enable row level security;
drop policy if exists massage_tips_all on public.massage_tips;
create policy massage_tips_all on public.massage_tips for all to public using (true) with check (true);

create table if not exists public.massage_provider_residences (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.massage_providers(id) on delete cascade,
  residence_id uuid not null references public.food_residences(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (provider_id, residence_id)
);
create index if not exists idx_massage_provider_residences_provider on public.massage_provider_residences (provider_id);
alter table public.massage_provider_residences enable row level security;
drop policy if exists massage_provider_residences_all on public.massage_provider_residences;
create policy massage_provider_residences_all on public.massage_provider_residences for all to public using (true) with check (true);
