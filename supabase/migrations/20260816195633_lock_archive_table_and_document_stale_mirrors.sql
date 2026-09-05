-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816195633 · lock_archive_table_and_document_stale_mirrors

-- The archive holds the same addresses and access instructions the occurrence
-- table does, so it gets the same treatment: RLS on, no policies, service role
-- only. A new public table without this is readable with the anon key.
alter table public._archive_orphan_occurrences_20260816 enable row level security;

comment on table public._archive_orphan_occurrences_20260816 is
  'Cleaning occurrences whose cleaning_bookings row no longer existed, removed 2026-08-16. Kept for recovery; safe to drop once nobody has missed them.';

-- Two tables that look authoritative and are not.
comment on table public.provider_subscriptions is
  'Universal subscriptions. Beach memberships are LIVE here. Rows with source_service_key = ''cleaning'' or ''food'' are a one-off 2026-07-04 backfill of the legacy tables and have not been resynced since — 11 of 23 cleaning and 8 of 24 food. Never aggregate money over this table without filtering by source_service_key.';

comment on table public.provider_bookings is
  'A partial 2026-07-04 backfill (86 of 179 cleaning bookings, 1 food) that no reader uses. Legacy cleaning_bookings and the engine''s bookings table are the live ones; service_occurrences is the unified read model.';
