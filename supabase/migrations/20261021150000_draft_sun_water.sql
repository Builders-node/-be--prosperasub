-- Applied 20261021150000 · draft_sun_water
--
-- DRAFT — a water-delivery service with Sun Water Company (Coxen Hole) as its
-- first provider. Nothing here is live: the archetype, category, provider and
-- every plan are switched off, so Discovery, the listings and checkout ignore
-- them. An admin sees it with ?preview=1:
--   /services/water?preview=1
--   /services/water/providers/5a1e0000-0000-4000-8000-00000000a7e1?preview=1
-- Launch = set service_archetypes.is_active, service_categories.is_active,
-- providers.status and the plans' status to active (Admin → Marketplace).
--
-- PRICES ARE PLACEHOLDERS until Sun Water confirms theirs: Roatán 5-gal jugs
-- run $2–4 at a shop and $3–5 delivered (sources in the research notes), and
-- the plans below assume ~$3.75–4 per delivered jug, 4.33 weeks a month.
-- Contact details are public (roatanyp.com, Instagram) — no owner account yet.

insert into public.service_archetypes (key, label, icon, accent, sort_order, is_active, source_service_key)
values ('water', 'Water', 'droplets', 'bg-sky-500', 50, false, null)
on conflict (key) do nothing;

insert into public.service_categories (key, label, icon, accent, sort_order, is_active, archetype_key)
values ('water_delivery', 'Drinking water', 'droplets', 'bg-sky-500', 10, false, 'water')
on conflict (key) do nothing;

insert into public.providers (
  id, archetype_key, category_key, name, description, location, working_hours,
  contact_phone, capabilities, status, is_platform_owned, delivery_info, unit
) values (
  '5a1e0000-0000-4000-8000-00000000a7e1',
  'water', 'water_delivery',
  'Sun Water Company',
  'El Agua de Roatán — purified drinking water, bottled here on the island. 5-gallon jugs delivered to your door on a set day each week, so the cooler is never empty and nobody carries 19 litres up the stairs.',
  'Coxen Hole, Roatán',
  '[{"days":["MO","TU","WE","TH","FR","SA"],"open":"08:00","close":"17:00"}]'::jsonb,
  '+504 9963-3711',
  array['delivery'],
  'inactive',
  false,
  'Delivered weekly on your route day — Coxen Hole, French Harbour, Pristine Bay and Próspera. Empties are collected when the full jugs arrive. Order changes by Friday for the next week.',
  'marketplace'
)
on conflict (id) do nothing;

insert into public.provider_plans (
  provider_id, name, description, price_cents, currency, period, status, sort_order,
  pricing_mode, fulfilment, included_quantity, included_unit, features,
  periods_min, periods_default, periods_max, visibility
) values
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Water Weekly · 1 jug',
   'One 5-gallon jug every week — enough for one person drinking and cooking.',
   1700, 'USD', 'monthly', 'inactive', 10, 'flat', 'deliveries', 4, 'jug',
   '["1 × 5-gal jug a week","Delivered on your route day","Empty collected each visit","Pause or cancel any month"]'::jsonb,
   1, 1, 6, 'public'),
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Water Weekly · 2 jugs',
   'Two jugs a week — the usual for a couple in the heat.',
   3200, 'USD', 'monthly', 'inactive', 20, 'flat', 'deliveries', 8, 'jug',
   '["2 × 5-gal jugs a week","Delivered on your route day","Empties collected","Pause or cancel any month"]'::jsonb,
   1, 1, 6, 'public'),
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Family · 4 jugs',
   'Four jugs a week for a household — drinking, cooking, coffee, the kids.',
   6000, 'USD', 'monthly', 'inactive', 30, 'flat', 'deliveries', 16, 'jug',
   '["4 × 5-gal jugs a week","Delivered on your route day","Empties collected","Best price per jug"]'::jsonb,
   1, 1, 6, 'public'),
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Business · 10 jugs',
   'Ten jugs a week for a café, office or rental — fixed day, one invoice a month.',
   14000, 'USD', 'monthly', 'inactive', 40, 'flat', 'deliveries', 40, 'jug',
   '["10 × 5-gal jugs a week","Fixed weekly delivery","Monthly invoice, Bitcoin or PayPal","More? Ask for a custom route"]'::jsonb,
   1, 1, 12, 'public'),
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Starter kit',
   'Your first jug with its deposit and a hand pump — the one-off that gets a new home set up.',
   1000, 'USD', 'one_time', 'inactive', 50, 'flat', 'deliveries', 1, 'jug',
   '["1 full 5-gal jug","Jug deposit included","Hand pump","Delivered with your first order"]'::jsonb,
   1, 1, 1, 'public'),
  ('5a1e0000-0000-4000-8000-00000000a7e1', 'Event · 10 jugs',
   'Ten jugs delivered once, for a party, a retreat or a busy week of guests.',
   4000, 'USD', 'one_time', 'inactive', 60, 'flat', 'deliveries', 10, 'jug',
   '["10 × 5-gal jugs, one delivery","Pick the date","Empties collected after"]'::jsonb,
   1, 1, 1, 'public');
