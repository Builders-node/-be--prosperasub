-- "Get it at the till": a customer scans the business's till QR, sees what
-- their subscription there includes, and presses Get. Each press is one row
-- here; the business sees them on its Schedule (Edge routes/redeem.ts).
--
--   item_key 'occ:<uuid>'  today's scheduled meal (service_occurrences) — the
--                          occurrence is marked done at the same time
--   item_key 'unit'        one of the plan's counted items (included_quantity
--                          per period, e.g. 4 massages)
--   item_key 'visit'       a plan with no count — once per day
--
-- Service-role only: it says who was where and when. Safe to run twice.

create table if not exists public.redemptions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  user_id uuid,
  subscription_table text not null check (subscription_table in ('provider_subscriptions', 'food_subscriptions')),
  subscription_id text not null,
  plan_name text,
  item_key text not null,
  item_label text not null,
  occurrence_id uuid references public.service_occurrences(id) on delete set null,
  -- 'customer' = pressed by the customer after scanning the till QR;
  -- 'pin' = recorded at the till with the business's code (next step).
  method text not null default 'customer' check (method in ('customer', 'pin')),
  -- The business day it counts for (Roatán), so "once a day" is one index.
  day date not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid
);

create index if not exists redemptions_provider_day_idx on public.redemptions (provider_id, day desc, created_at desc);
create index if not exists redemptions_subscription_idx on public.redemptions (subscription_table, subscription_id);
-- A meal is collected once.
create unique index if not exists redemptions_occurrence_uidx on public.redemptions (occurrence_id)
  where occurrence_id is not null and voided_at is null;
-- An uncounted plan: one visit a day.
create unique index if not exists redemptions_visit_day_uidx on public.redemptions (subscription_table, subscription_id, day)
  where item_key = 'visit' and voided_at is null;

alter table public.redemptions enable row level security;
revoke all on public.redemptions from anon, authenticated;

comment on table public.redemptions is
  'What a customer collected at the till (scan → Get). Service-role only; read and written by Edge routes/redeem.ts.';
