-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060716 · unify_b1_occurrence_source_subscription

-- While both models run, an occurrence's subscription is still a LEGACY row
-- (cleaning_subscriptions / food_subscriptions). `subscription_id` is reserved
-- for the universal one; this holds the legacy id until phase F resolves them.
-- Writing a legacy id into a column that means "provider_subscriptions.id"
-- would be a lie the next reader believes.
alter table service_occurrences add column if not exists source_subscription_id text;
create index if not exists service_occurrences_source_sub_idx
  on service_occurrences (source_service_key, source_subscription_id);
