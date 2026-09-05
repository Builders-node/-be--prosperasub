-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626201235 · cleaning_reviews_and_tips

create table if not exists public.cleaning_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  booking_id text not null,
  customer_name text,
  rating integer not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, user_id)
);
alter table public.cleaning_reviews enable row level security;
drop policy if exists cleaning_reviews_all on public.cleaning_reviews;
create policy cleaning_reviews_all on public.cleaning_reviews for all to public using (true) with check (true);

create table if not exists public.cleaning_tips (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  booking_id text not null,
  customer_name text,
  amount_cents integer not null,
  message text,
  payment_status text not null default 'paid',
  payment_method text,
  payment_reference text,
  created_at timestamptz not null default now()
);
create index if not exists idx_cleaning_tips_booking on public.cleaning_tips (booking_id);
alter table public.cleaning_tips enable row level security;
drop policy if exists cleaning_tips_all on public.cleaning_tips;
create policy cleaning_tips_all on public.cleaning_tips for all to public using (true) with check (true);
