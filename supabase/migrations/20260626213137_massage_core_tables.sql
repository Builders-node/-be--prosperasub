-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260626213137 · massage_core_tables

create table if not exists public.massage_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  avatar_url text,
  banner_url text,
  location text,
  working_hours text,
  status text not null default 'active',
  sort_order integer not null default 0,
  admin_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.massage_plans (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.massage_providers(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null default 0,
  duration_minutes integer not null default 60,
  sessions_per_period integer not null default 1,
  highlights jsonb,
  status text not null default 'active',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_massage_plans_provider on public.massage_plans (provider_id);

create table if not exists public.massage_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  provider_id uuid not null references public.massage_providers(id) on delete cascade,
  plan_id uuid references public.massage_plans(id) on delete set null,
  status text not null default 'pending',
  price_cents integer not null default 0,
  commitment_weeks integer default 4,
  sessions_total integer default 0,
  sessions_used integer default 0,
  started_at date,
  end_date date,
  customer_name text,
  customer_whatsapp text,
  residence text,
  location text,
  notes text,
  admin_notes text,
  payment_status text default 'pending',
  payment_method text,
  payment_reference text,
  periods_paid integer default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_massage_subs_provider on public.massage_subscriptions (provider_id);

create table if not exists public.massage_slots (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.massage_providers(id) on delete cascade,
  date date not null,
  start_time time not null,
  end_time time not null,
  capacity integer not null default 1,
  current_bookings integer not null default 0,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create index if not exists idx_massage_slots_provider_date on public.massage_slots (provider_id, date);

create table if not exists public.massage_bookings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  provider_id uuid not null references public.massage_providers(id) on delete cascade,
  slot_id uuid references public.massage_slots(id) on delete set null,
  subscription_id uuid references public.massage_subscriptions(id) on delete set null,
  status text not null default 'booked',
  customer_name text,
  customer_whatsapp text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_massage_bookings_provider on public.massage_bookings (provider_id);
