-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260710181816 · add_booking_settings_to_rental_vehicles

ALTER TABLE public.rental_vehicles
  ADD COLUMN IF NOT EXISTS booking_settings jsonb;

COMMENT ON COLUMN public.rental_vehicles.booking_settings IS
  'Per-vehicle booking calendar override (weekly hours, notice, advance, blocks). '
  'NULL = inherit from providers.booking_settings for the parent rental provider. '
  'Shape matches lib/booking/bookingSettings.ts BookingSettings.';
