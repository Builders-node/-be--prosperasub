-- Paid Beach Club memberships (replaces the inquiry flow).
create table if not exists public.beach_club_subscriptions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references public.beach_club_plans(id) on delete set null,
  plan_name text,
  user_id text,
  customer_name text,
  customer_email text,
  people integer not null default 1,
  start_date date,
  end_date date,
  price_per_person_cents integer,
  total_cents integer,
  payment_status text not null default 'pending',
  payment_method text,
  payment_reference text,
  status text not null default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.beach_club_subscriptions enable row level security;
create policy beach_club_subscriptions_all on public.beach_club_subscriptions for all to public using (true) with check (true);
