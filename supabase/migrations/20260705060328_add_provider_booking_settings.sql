-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260705060328 · add_provider_booking_settings

ALTER TABLE public.providers ADD COLUMN IF NOT EXISTS booking_settings jsonb;
COMMENT ON COLUMN public.providers.booking_settings IS 'Unified per-provider booking configuration (weekly hours, session duration, buffers, scheduling rules, blocked dates/ranges). Shape defined in frontend/src/lib/booking/bookingSettings.ts';
