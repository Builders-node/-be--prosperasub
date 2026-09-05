-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816200624 · protect_money_from_provider_delete

-- Deleting a provider row must not delete money.
--
-- `provider_subscriptions` holds the beach club's LIVE memberships and
-- `provider_payouts` is the ledger the platform pays against; both cascaded
-- from `providers`, so one `delete from providers where …` would have taken
-- six paid memberships and every payout record with it, silently. There is no
-- delete button in the admin — this is about the day somebody writes the SQL.
--
-- RESTRICT instead: the delete fails, loudly, and whoever meant it moves the
-- rows first. Everything else (plans, resources, reviews, members) keeps
-- cascading — that is provider content, not provider money.
alter table public.provider_subscriptions
  drop constraint if exists provider_subscriptions_provider_id_fkey;
alter table public.provider_subscriptions
  add constraint provider_subscriptions_provider_id_fkey
  foreign key (provider_id) references public.providers(id) on delete restrict;

alter table public.provider_payouts
  drop constraint if exists provider_payouts_provider_id_fkey;
alter table public.provider_payouts
  add constraint provider_payouts_provider_id_fkey
  foreign key (provider_id) references public.providers(id) on delete restrict;

-- One column name, two vocabularies — worth saying so where it is read.
comment on column public.provider_plans.pricing_mode is
  'How the price scales: flat | per_unit | per_person | derived. NOT the same vocabulary as cleaning_packages.pricing_mode (price_per_cleaning | fixed_monthly_price), which is about how a cleaning package is quoted.';

comment on column public.cleaning_packages.pricing_mode is
  'How this package is quoted: price_per_cleaning | fixed_monthly_price. NOT the same vocabulary as provider_plans.pricing_mode (flat | per_unit | per_person | derived).';

comment on column public.provider_plans.fulfilment is
  'What has to happen after the sale: none | visits | deliveries | resource_hours. Checkout reads it to decide whether to ask for an address; the provider_plans_classify trigger fills it when a writer does not.';
