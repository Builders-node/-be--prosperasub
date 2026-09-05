-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260704235136 · f1_source_ids_to_text


-- Some legacy tables use TEXT ids (cleaning_packages/cleaning_subscriptions,
-- and some cleaning_bookings-adjacent tables). Widen the source-tracking
-- columns to TEXT so the backfill can point at either UUID- or TEXT-keyed
-- rows without lossy casts.
ALTER TABLE public.provider_plans         ALTER COLUMN source_plan_id         TYPE text;
ALTER TABLE public.provider_bookings      ALTER COLUMN source_booking_id      TYPE text;
ALTER TABLE public.provider_subscriptions ALTER COLUMN source_subscription_id TYPE text;
ALTER TABLE public.bookable_resources     ALTER COLUMN source_resource_id     TYPE text;
