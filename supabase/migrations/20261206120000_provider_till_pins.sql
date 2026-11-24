-- The till PIN: staff scan a customer's subscription QR on any phone, press
-- Get and type the business's PIN — no sign-in (Edge routes/redeem.ts,
-- /till/*). The owner sets it in the workspace (Overview → QR codes → At the
-- till).
--
-- Its own table, not a column on providers: providers is readable with the
-- public key, and a 4–6 digit PIN's hash is a second's work to reverse. This
-- one is service-role only. The hash is PBKDF2 with a per-row salt; five wrong
-- PINs lock the till for 15 minutes.
--
-- Safe to run twice.

create table if not exists public.provider_till_pins (
  provider_id uuid primary key references public.providers(id) on delete cascade,
  pin_hash text not null,
  salt text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.provider_till_pins enable row level security;
revoke all on public.provider_till_pins from anon, authenticated;

comment on table public.provider_till_pins is
  'Till PIN per business (PBKDF2 hash + salt, lockout counters). Service-role only — never add a policy.';
