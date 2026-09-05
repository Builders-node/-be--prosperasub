-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814062059 · unify_c2_mirror_adopts_generated

-- When a delivery is marked, the log arrives for a day the generator has
-- already scheduled. Without this the mirror would insert a second row and the
-- provider's screen would show the same meal twice — once planned, once done.
-- So the log ADOPTS the generated occurrence rather than duplicating it.
create or replace function mirror_find_occurrence(
  p_svc text, p_record_id text, p_item text, p_sub text, p_start timestamptz
) returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from (
    -- the row this legacy record already owns
    select o.id, 1 as rank from service_occurrences o
     where o.source_service_key = p_svc
       and o.source_record_id = p_record_id
       and coalesce(o.item_key, '') = coalesce(p_item, '')
    union all
    -- otherwise a generated one for the same subscription, day and item
    select o.id, 2 from service_occurrences o
     where o.source_service_key = p_svc
       and o.source_record_id is null
       and o.source_subscription_id = p_sub
       and coalesce(o.item_key, '') = coalesce(p_item, '')
       and cast((o.starts_at at time zone 'America/Tegucigalpa') as date)
         = cast((p_start   at time zone 'America/Tegucigalpa') as date)
  ) m order by rank limit 1;
$$;
