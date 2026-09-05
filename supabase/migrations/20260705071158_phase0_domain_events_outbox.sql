-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705071158 · phase0_domain_events_outbox

-- Phase 0: transactional outbox for the domain event bus (DDD migration).
create table if not exists public.domain_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  version int not null default 1,
  occurred_at timestamptz not null default now(),
  subject_ref text,
  correlation_id uuid,
  causation_id uuid,
  payload jsonb not null default '{}'::jsonb,
  published_at timestamptz
);
create index if not exists domain_events_unpublished_idx on public.domain_events (occurred_at) where published_at is null;
create index if not exists domain_events_type_idx on public.domain_events (type);

-- Per-consumer delivery ledger for idempotent, at-least-once dispatch.
create table if not exists public.domain_event_deliveries (
  event_id uuid not null references public.domain_events(id) on delete cascade,
  consumer text not null,
  delivered_at timestamptz not null default now(),
  primary key (event_id, consumer)
);

-- Backend-only (Prisma connects via DATABASE_URL and bypasses RLS). Enable RLS
-- with no policies so the anon PostgREST role cannot read/write the outbox.
alter table public.domain_events enable row level security;
alter table public.domain_event_deliveries enable row level security;
