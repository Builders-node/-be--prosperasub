-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260630205826 · provider_onboarding_core

-- Applications to become a provider (public form → admin review)
create table if not exists public.provider_applications (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  service text not null,
  business_name text not null,
  contact_email text,
  contact_phone text,
  description text,
  residence text,
  status text not null default 'pending',
  review_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_provider_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists provider_applications_status_idx on public.provider_applications (status, created_at desc);
create index if not exists provider_applications_user_idx on public.provider_applications (user_id);
alter table public.provider_applications enable row level security;

-- Maps a user to the provider entity they own/manage, per service. Source of
-- truth for provider-portal access scoping.
create table if not exists public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  service text not null,
  provider_id text not null,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (user_id, service, provider_id)
);
create index if not exists provider_accounts_user_idx on public.provider_accounts (user_id);
alter table public.provider_accounts enable row level security;
