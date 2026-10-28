-- Applied 20261028120000 · paypal_auto_renew_all_services
--
-- PayPal auto-renew for every service, not only memberships: food and
-- cleaning subscriptions live in their own tables, so they get the same two
-- columns provider_subscriptions got in 20261021090000. Additive only.
--
-- A term of N weeks (food) or N months (cleaning) becomes one PayPal billing
-- cycle of N × unit — PayPal allows WEEK up to 52 and MONTH up to 12 — so
-- paypal_billing_plans.interval_count widens from 12 to 52.

alter table public.food_subscriptions
  add column if not exists paypal_subscription_id text,
  add column if not exists auto_renew boolean not null default false;
create unique index if not exists food_subscriptions_paypal_subscription_uidx
  on public.food_subscriptions (paypal_subscription_id) where paypal_subscription_id is not null;

alter table public.cleaning_subscriptions
  add column if not exists paypal_subscription_id text,
  add column if not exists auto_renew boolean not null default false;
create unique index if not exists cleaning_subscriptions_paypal_subscription_uidx
  on public.cleaning_subscriptions (paypal_subscription_id) where paypal_subscription_id is not null;

alter table public.paypal_billing_plans drop constraint if exists paypal_billing_plans_interval_count_check;
alter table public.paypal_billing_plans
  add constraint paypal_billing_plans_interval_count_check check (interval_count between 1 and 52);
