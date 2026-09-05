-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260619222817 · food_subscriptions_lifecycle_end_date

-- Authoritative period-end date for food subscriptions.
ALTER TABLE public.food_subscriptions ADD COLUMN IF NOT EXISTS end_date date;

-- Backfill: end_date = period start + (weeks * 7). Matches the existing
-- reminder-cron convention (started_at + commitment_weeks*7).
UPDATE public.food_subscriptions
SET end_date = (COALESCE(started_at::date, created_at::date) + (GREATEST(COALESCE(commitment_weeks, 1), 1) * 7))
WHERE end_date IS NULL;

-- Flip already-overdue active subscriptions to expired (Honduras local date).
UPDATE public.food_subscriptions
SET status = 'expired', updated_at = now()
WHERE status = 'active'
  AND end_date < (now() AT TIME ZONE 'America/Tegucigalpa')::date;
