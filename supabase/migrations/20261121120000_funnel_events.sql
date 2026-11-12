-- The sales funnel, per business: how many people saw the business, opened a
-- plan, started checkout and picked a way to pay. "Paid" is not an event — it
-- is read from the orders themselves (subscriptions_unified), which cannot be
-- faked or lost by an ad blocker.
--
-- A row is one browser session reaching one stage for one plan, once a day
-- (the unique index) — reloading a page does not inflate the numbers.
-- `session_id` is a random id kept in the browser's sessionStorage; no IP, no
-- user agent. Written only through the Edge api (POST /funnel/events), read
-- only through it (GET /account/providers/:id/funnel) — service role only.

create table if not exists public.funnel_events (
  id bigint generated always as identity primary key,
  provider_id uuid not null,
  plan_ref text,
  stage text not null check (stage = any (array['provider_view','plan_view','checkout_start','payment_chosen'])),
  session_id text not null check (char_length(session_id) between 8 and 64),
  user_id text,
  day date not null default (now() at time zone 'America/Tegucigalpa')::date,
  created_at timestamptz not null default now()
);

create unique index if not exists funnel_events_once_a_day
  on public.funnel_events (provider_id, stage, coalesce(plan_ref, ''), session_id, day);
create index if not exists funnel_events_provider_day on public.funnel_events (provider_id, day);

alter table public.funnel_events enable row level security;
revoke all on public.funnel_events from anon, authenticated;

comment on table public.funnel_events is
  'Sales funnel per business (views → checkout → payment chosen); paid comes from the orders. Service-role only, via the Edge api.';
