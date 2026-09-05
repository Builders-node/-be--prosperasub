-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060325 · unify_a4_occurrence_indexes_and_rls

-- The provider's daily run reads by provider + day; the customer's screen by
-- subscription; the dual-write dedupes by the legacy row it mirrors.
create index if not exists service_occurrences_provider_day_idx
  on service_occurrences (provider_id, starts_at);
create index if not exists service_occurrences_subscription_idx
  on service_occurrences (subscription_id);
create index if not exists service_occurrences_user_idx
  on service_occurrences (user_id);
create unique index if not exists service_occurrences_source_uidx
  on service_occurrences (source_service_key, source_record_id, coalesce(item_key, ''))
  where source_record_id is not null;

-- RLS on with NO policies: service-role only, the `provider_payouts` posture
-- rather than the permissive one the older service tables use. This table
-- carries home addresses and access instructions ("key under the mat"), and
-- nothing in the browser reads it yet — so it starts closed, and any future
-- browser read has to be a deliberate policy rather than an inherited default.
alter table service_occurrences enable row level security;
