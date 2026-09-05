-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814072003 · unify_e1_plan_selection_group

-- What the customer picks INSIDE a plan, without changing its price.
--
-- Food's three meals are the only instance today, and they are hard-coded in
-- the food checkout — which is precisely why "one checkout for every service"
-- was impossible: the screen had to know what a meal was. As data, the same
-- control serves a restaurant picking meals, a gym picking classes, or nobody
-- at all.
--
-- An AXIS changes the price and resolves to a plan row; a SELECTION does not
-- and lives on the subscription. Keeping them in different columns is what
-- stops one restaurant from needing 24 plan rows.
alter table provider_plans
  add column if not exists selection_group jsonb;

-- Backfill food: pick N of breakfast / lunch / dinner, where N is the plan's
-- meals per day. The customer's own screen already worked this way; this only
-- moves the knowledge out of the component.
update provider_plans p set selection_group = jsonb_build_object(
  'key', 'meals',
  'label', 'Which meals',
  'min', 1,
  'max', greatest(1, coalesce(f.meals_per_day, 1)),
  'options', jsonb_build_array(
    jsonb_build_object('key', 'breakfast', 'label', 'Breakfast'),
    jsonb_build_object('key', 'lunch',     'label', 'Lunch'),
    jsonb_build_object('key', 'dinner',    'label', 'Dinner')
  )
)
from food_meal_plans f
where p.source_service_key = 'food'
  and p.source_plan_id = f.id::text
  and p.selection_group is null;
