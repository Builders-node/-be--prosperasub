-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705120150 · phase4b_bookings_and_waitlist

-- Phase 4b: Booking write side. A Booking is the aggregate; a Hold is its
-- 'held' state (with a TTL). The partial unique index enforces the core
-- invariant — no two ACTIVE claims on the same resource+slot (capacity=1).
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  provider_id uuid,
  subject_ref text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  slot_key text not null,                 -- resourceId|date|from
  status text not null default 'held',    -- held | confirmed | cancelled | completed | no_show | released
  order_ref text,
  expires_at timestamptz,                 -- TTL for the 'held' state
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists bookings_active_slot_uidx
  on public.bookings (resource_id, slot_key) where status in ('held','confirmed');
create index if not exists bookings_status_idx on public.bookings (status);
create index if not exists bookings_expires_idx on public.bookings (expires_at) where status = 'held';
alter table public.bookings enable row level security;

create table if not exists public.booking_waitlist (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  slot_key text not null,
  subject_ref text,
  status text not null default 'waiting', -- waiting | promoted | left
  created_at timestamptz not null default now()
);
create index if not exists booking_waitlist_slot_idx on public.booking_waitlist (resource_id, slot_key, status);
alter table public.booking_waitlist enable row level security;
