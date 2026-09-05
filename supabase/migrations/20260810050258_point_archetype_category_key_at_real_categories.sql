-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810050258 · point_archetype_category_key_at_real_categories

-- service_archetypes.category_key named transport / food / home / venues — none
-- of which exists in service_categories. The trigger that reads it can no
-- longer cause an FK violation (see the previous migration), but the column was
-- still pointing at nothing, so its fallback never fired either.
--
-- Repoint each archetype at its own first active category, by data rather than
-- by another hard-coded guess.

update service_archetypes a
set category_key = (
  select sc.key
  from service_categories sc
  where sc.archetype_key = a.key and sc.is_active
  order by sc.sort_order, sc.key
  limit 1
)
where a.category_key is distinct from (
  select sc.key
  from service_categories sc
  where sc.archetype_key = a.key and sc.is_active
  order by sc.sort_order, sc.key
  limit 1
);
