-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810055933 · provider_plans_included_quantity

-- "4 massages a month, $100" needs the 4 to be a number, not a phrase inside the
-- plan name. Kept generic: the same two columns describe 8 car washes a month,
-- 3 classes a week or 10 deliveries a quarter.
--
-- Both nullable. A plan that is simply "access for a month" leaves them null
-- and renders exactly as it does today.

alter table provider_plans
  add column if not exists included_quantity integer,
  add column if not exists included_unit text;

comment on column provider_plans.included_quantity is
  'How many of the thing are included per `period`. Null = unmetered access.';
comment on column provider_plans.included_unit is
  'Singular noun for what is counted — "massage", "wash", "class". Pluralised for display.';

-- A count of zero or less is not a smaller plan, it is a mistake.
alter table provider_plans
  drop constraint if exists provider_plans_included_quantity_positive;
alter table provider_plans
  add constraint provider_plans_included_quantity_positive
  check (included_quantity is null or included_quantity > 0);
