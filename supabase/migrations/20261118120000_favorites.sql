-- Favourites: what a customer liked and kept, to come back to.
--
-- Three kinds of thing can be saved — a plan (any service's offer), a business
-- and a vehicle. `target_id` is the CANONICAL id: a plan is stored by its
-- universal provider_plans.id even when it was saved from a card that knew
-- only the legacy id, so the same plan saved from two screens is one row.
-- The Edge api resolves that before writing.
--
-- Service-role only, no policies: auth is the platform's own JWT, which RLS
-- cannot see, so every read and write goes through the Edge api
-- (/account/favorites), scoped to the caller.

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  kind text not null check (kind = any (array['plan','provider','vehicle'])),
  target_id text not null check (char_length(target_id) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (user_id, kind, target_id)
);

create index if not exists favorites_user_created_idx on public.favorites (user_id, created_at desc);
-- "How many people saved this" — for the business, later.
create index if not exists favorites_target_idx on public.favorites (kind, target_id);

alter table public.favorites enable row level security;
revoke all on public.favorites from anon, authenticated;

comment on table public.favorites is
  'What a customer saved to come back to: plans (canonical provider_plans.id), businesses, vehicles. Service-role only; read and written through the Edge api /account/favorites.';
