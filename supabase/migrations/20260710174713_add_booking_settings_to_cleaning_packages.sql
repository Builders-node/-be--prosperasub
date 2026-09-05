-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260710174713 · add_booking_settings_to_cleaning_packages

ALTER TABLE public.cleaning_packages
  ADD COLUMN IF NOT EXISTS booking_settings jsonb;

COMMENT ON COLUMN public.cleaning_packages.booking_settings IS
  'Per-plan booking calendar override (weekly hours, duration, buffers, blocks). '
  'NULL = inherit from providers.booking_settings for the parent provider. '
  'Shape matches lib/booking/bookingSettings.ts BookingSettings.';
