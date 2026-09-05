-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060301 · unify_a2_subscription_columns

alter table provider_subscriptions
  -- food's renewal counter, which every service needs once renewal is shared
  add column if not exists periods_paid int not null default 1,
  -- what the customer chose INSIDE the plan (which meals). Not an axis: it
  -- does not change the price, so it belongs on the subscription and not on a
  -- plan row. Editable after purchase, up to the next generated occurrence.
  add column if not exists selections jsonb,
  -- where the service happens
  add column if not exists service_address text,
  add column if not exists service_area_id uuid,
  -- which combination was bought, denormalised so history survives a plan edit
  add column if not exists option_keys jsonb;
