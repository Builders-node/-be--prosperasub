-- Applied 20261021090000 · paypal_auto_renew
--
-- PayPal Subscriptions: a membership the customer approves once and PayPal
-- charges every period. Additive only — the database is shared by dev and
-- production, and the code on production must keep working against it.
--
-- provider_subscriptions.paypal_subscription_id  PayPal's I-… id; the webhook
--   finds the row by it. Unique: one PayPal subscription renews one row.
-- provider_subscriptions.auto_renew  true while PayPal will charge again; the
--   webhook clears it on cancel/suspend/expire. Access still runs to end_date.
-- paypal_billing_plans  our plan → PayPal product + plan, per environment and
--   per price, created on first use. A price change makes a NEW PayPal plan
--   (PayPal plans cannot be repriced for existing subscribers without consent).
--
-- Renewal charges are recorded exactly like a manual renewal: one
-- subscription_renewals row (idempotency_key = the PayPal sale id) and the
-- subscription's dates moved forward a period.

alter table public.provider_subscriptions
  add column if not exists paypal_subscription_id text,
  add column if not exists auto_renew boolean not null default false;

create unique index if not exists provider_subscriptions_paypal_subscription_uidx
  on public.provider_subscriptions (paypal_subscription_id)
  where paypal_subscription_id is not null;

create table if not exists public.paypal_billing_plans (
  id uuid primary key default gen_random_uuid(),
  provider_plan_id uuid not null references public.provider_plans(id) on delete restrict,
  env text not null check (env in ('live', 'sandbox')),
  unit_price_cents integer not null check (unit_price_cents > 0),
  currency text not null default 'USD',
  interval_unit text not null check (interval_unit in ('WEEK', 'MONTH', 'YEAR')),
  interval_count integer not null default 1 check (interval_count between 1 and 12),
  paypal_product_id text not null,
  paypal_plan_id text not null unique,
  created_at timestamptz not null default now(),
  unique (provider_plan_id, env, unit_price_cents, currency, interval_unit, interval_count)
);

-- Service role only (the Edge API). No policies on purpose.
alter table public.paypal_billing_plans enable row level security;

comment on table public.paypal_billing_plans is
  'Our provider_plans mapped to PayPal billing plans, per env and price. Written by the Edge API (functions/api/lib/paypal.ts) on first use.';
