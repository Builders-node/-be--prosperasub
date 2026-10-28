-- Applied 20261021170000 · draft_sun_water_profile
--
-- Sun Water's draft profile for the marketplace: their own logo (the public
-- Instagram profile picture, 100px upscaled to 400 — ask them for the original
-- file before launch), the copy, and the public contacts (WhatsApp from their
-- Instagram, office line from roatanyp.com). Still inactive.

update public.providers set
  avatar_url = 'https://igbytraidldkhhamsfdo.supabase.co/storage/v1/object/public/media/providers/sun-water/avatar.jpg',
  description =
    'Sun Water — El Agua de Roatán. Purified drinking water, bottled here on the island in Coxen Hole and brought to your door in 5-gallon jugs.' || E'\n\n' ||
    'On EverySub you choose how many jugs a week you need and pay once a month — in Bitcoin or by PayPal. The driver swaps your empties for full jugs on the same day every week: no calls, no carrying 19 litres up the stairs, no running dry on a Sunday.' || E'\n\n' ||
    'For homes, rentals, cafés and offices. Office +504 2455-5932 · WhatsApp +504 9963-3711 · Instagram @sunwaterroatan',
  location = 'Coxen Hole, Roatán (Bay Islands)',
  contact_phone = '+504 9963-3711',
  delivery_info =
    'Weekly delivery on a fixed day for your area — Coxen Hole, French Harbour, Pristine Bay and Próspera. ' ||
    'Empties are collected when the full jugs arrive. Changes for the next week by Friday. Orders and changes go through EverySub; for anything urgent, WhatsApp +504 9963-3711.',
  working_hours = '[{"days":["MO","TU","WE","TH","FR","SA"],"open":"08:00","close":"17:00"}]'::jsonb,
  updated_at = now()
where id = '5a1e0000-0000-4000-8000-00000000a7e1';
