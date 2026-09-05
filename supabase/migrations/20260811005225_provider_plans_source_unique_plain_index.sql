-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811005225 · provider_plans_source_unique_plain_index

-- ON CONFLICT cannot infer a PARTIAL index without repeating its predicate, and
-- the trigger's upsert failed on exactly that. A plain unique index does the
-- job: NULLs compare as distinct in Postgres, so the many native rows with no
-- source_* stay unconstrained, while each mirrored legacy row is unique.

drop index if exists provider_plans_source_uniq;

create unique index if not exists provider_plans_source_uniq
  on provider_plans (source_service_key, source_plan_id);
