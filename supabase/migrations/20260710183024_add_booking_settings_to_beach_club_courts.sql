-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260710183024 · add_booking_settings_to_beach_club_courts

ALTER TABLE public.beach_club_courts
  ADD COLUMN IF NOT EXISTS booking_settings jsonb;

COMMENT ON COLUMN public.beach_club_courts.booking_settings IS
  'Per-court booking calendar override (working hours, blocks, notice, advance). '
  'NULL = inherit the parent providers.booking_settings for the beach club provider. '
  'Shape matches lib/booking/bookingSettings.ts BookingSettings.';
