-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814072114 · unify_e2_backfill_included_quantity

-- How many of the thing a period includes. It existed only in each legacy
-- table under a different name — `cleanings_per_month`, `meals_per_week` — so
-- any shared checkout would have had to know what a cleaning and a meal are.
-- On the universal row it is just a number and a noun.
update provider_plans p set
  included_quantity = coalesce(p.included_quantity, c.cleanings_per_month),
  included_unit     = coalesce(p.included_unit, 'cleaning')
from cleaning_packages c
where p.source_service_key = 'cleaning' and p.source_plan_id = c.id::text;

update provider_plans p set
  included_quantity = coalesce(p.included_quantity, nullif(f.meals_per_week, 0)),
  included_unit     = coalesce(p.included_unit, 'meal')
from food_meal_plans f
where p.source_service_key = 'food' and p.source_plan_id = f.id::text;
