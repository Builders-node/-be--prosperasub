-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814062045 · unify_c1_generated_occurrence_identity

-- A generated occurrence mirrors no legacy row, so the source-based unique
-- index does not constrain it. Its identity is the thing it actually is:
-- this subscription, this day, this meal.
create unique index if not exists service_occurrences_generated_uidx
  on service_occurrences (
    source_service_key,
    source_subscription_id,
    (cast((starts_at at time zone 'America/Tegucigalpa') as date)),
    coalesce(item_key, '')
  )
  where source_record_id is null and source_subscription_id is not null;
