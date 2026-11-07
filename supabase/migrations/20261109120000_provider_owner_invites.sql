-- A link that hands a business to its owner.
--
-- Setting an owner used to need the person's account id typed into an admin
-- sheet, so a business created by the platform stayed platform-owned until the
-- owner signed up AND somebody found their id. Now the admin makes a link, sends
-- it however they talk to that person, and whoever opens it signed in becomes
-- the owner. Single use, seven days, one open link per business.
--
-- Only the token's SHA-256 is stored: the table never holds a working link.
-- Service-role only (RLS on, no policies) — written and read by the Edge `api`
-- (routes/owner-invites.ts), never from the browser.

create table if not exists public.provider_owner_invites (
  id          uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  token_hash  text not null unique,
  created_by  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  claimed_by  uuid,
  claimed_at  timestamptz,
  revoked_at  timestamptz
);

create index if not exists provider_owner_invites_provider_idx
  on public.provider_owner_invites (provider_id, created_at desc);

alter table public.provider_owner_invites enable row level security;
revoke all on table public.provider_owner_invites from anon, authenticated;

comment on table public.provider_owner_invites is
  'Owner hand-over links. sha256(token) only; service-role only; single use, 7 days. Written by Edge api routes/owner-invites.ts.';
