-- Applied 20261103120000 · draft_merchant_batch
--
-- DRAFTS for the 16 merchants on the outreach list, one provider each with the
-- offer to pitch as plans. Nothing here is live: new archetypes, categories,
-- providers and plans are all switched off, and checkout refuses a plan that is
-- not active. An admin sees them with ?preview=1:
--   /services/pantry?preview=1
--   /services/clubs?preview=1
--   /services/business?preview=1
--   /services/healthcare?preview=1   (BIFAT, inside the live Healthcare service)
--
-- New archetypes rather than Food / Lifestyle: an archetype with
-- source_service_key is shown by a legacy page that lists its own tables, so a
-- universal provider there would be invisible.
--
-- EVERY PRICE IS A PLACEHOLDER until the merchant confirms it. Only the Scuba
-- Shop and Pete's Place have public prices to anchor on (noted on their plans).
-- Contacts and addresses appear only where a public listing states them.
-- Not found publicly, name only: Palapa Pool Bar, CC Print & Design, Coco Monkey,
-- Roatan Fruit Dealer, Roatan Provision, Adrian's Gym, BIFAT.
-- BIFAT has no plan on purpose: the pitch is a question, and the clinic decides
-- what can be offered and who approves it.

insert into public.service_archetypes (key, label, icon, accent, sort_order, is_active, source_service_key) values
  ('pantry',   'Pantry & Drinks', 'shopping-bag', 'bg-amber-500',   60, false, null),
  ('clubs',    'Clubs & Sport',   'dumbbell',     'bg-cyan-500',    70, false, null),
  ('business', 'Business',        'store',        'bg-slate-500',   80, false, null)
on conflict (key) do nothing;

insert into public.service_categories (key, label, icon, accent, sort_order, is_active, archetype_key) values
  ('coffee',        'Coffee',            'shopping-bag', 'bg-amber-500', 10, false, 'pantry'),
  ('local_produce', 'Local produce',     'shopping-bag', 'bg-amber-500', 20, false, 'pantry'),
  ('drinks',        'Drinks',            'droplets',     'bg-amber-500', 30, false, 'pantry'),
  ('household',     'Household supplies','store',        'bg-amber-500', 40, false, 'pantry'),
  ('diving',        'Diving',            'waves',        'bg-cyan-500',  10, false, 'clubs'),
  ('golf',          'Golf',              'trophy',       'bg-cyan-500',  20, false, 'clubs'),
  ('pool_access',   'Pool access',       'waves',        'bg-cyan-500',  30, false, 'clubs'),
  ('gym',           'Gym',               'dumbbell',     'bg-cyan-500',  40, false, 'clubs'),
  ('print_design',  'Print & design',    'store',        'bg-slate-500', 10, false, 'business')
on conflict (key) do nothing;

insert into public.providers (
  id, archetype_key, category_key, name, description, location, working_hours,
  contact_phone, capabilities, status, is_platform_owned, delivery_info, unit
) values
  ('5a1e0000-0000-4000-8000-0000000000b1', 'pantry', 'coffee', 'Bean Crazy',
   'A café on West End Road. Your coffee paid for once a month, and beans brought home.',
   'West End, Roatán',
   '[{"days":["MO","TU","WE","TH","FR","SA"],"open":"07:00","close":"17:00"},{"days":["SU"],"open":"07:00","close":"14:00"}]'::jsonb,
   '+504 9622-8396', array['delivery'], 'inactive', false,
   'Beans delivered on a set day each week. Areas to be confirmed with Bean Crazy.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b2', 'clubs', 'diving', 'Roatan Yacht Club Divers',
   'Daily boat dives from the Roatan Yacht Club in French Harbour, most sites within 5–10 minutes by boat. A monthly pass for people who live here and dive regularly.',
   'Roatan Yacht Club Resort, French Harbour',
   '[{"days":["MO","TU","WE","TH","FR","SA","SU"],"open":"08:00","close":"16:00"}]'::jsonb,
   '+504 9985-7299', '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b3', 'healthcare', 'healthcare', 'BIFAT',
   'Draft placeholder. No offer until the clinic says what it can provide to existing clients. All clinical and refill decisions stay with the clinic.',
   null, null, null, '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b4', 'clubs', 'diving', 'Scuba Shop',
   'A dive shop on a private oceanfront beach below the Pristine Bay Beach Club. Gear is included in the price of your dive. Instagram @scubashoproatan.',
   'Pristine Bay, Roatán',
   '[{"days":["MO","TU","WE","TH","FR","SA","SU"],"open":"08:00","close":"16:00"}]'::jsonb,
   '+504 3293-4293', '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b5', 'clubs', 'golf', 'Pete''s Place',
   'The driving range at Pristine Bay Beach Club, on the Caribbean coast. A monthly plan for people who play regularly.',
   'Pristine Bay Beach Club, Roatán', null, null, '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b6', 'pantry', 'local_produce', 'Roatan Bees',
   'Raw, unfiltered honey with no added sugar, and mango jam made from the island''s creole mangoes with a little honey. Made on Roatán and brought to your door.',
   'Roatán', null, null, array['delivery'], 'inactive', false,
   'Delivered on a set schedule. Areas to be confirmed with Roatan Bees.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b7', 'pantry', 'drinks', 'Roatan Island Brewing Company',
   'Beer brewed on Roatán, delivered every month or in bulk for an event.',
   'Roatán', null, null, array['delivery'], 'inactive', false,
   'Delivered on a set schedule. Areas to be confirmed with the brewery.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b8', 'clubs', 'pool_access', 'Palapa Pool Bar',
   'Pool access for island residents, with a set amount to spend on food each month.',
   null, null, null, '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000b9', 'clubs', 'pool_access', 'Guava Grove Resort & Villas',
   'A swim pass for island residents at Guava Grove''s pool.',
   'Roatán', null, null, '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000ba', 'clubs', 'diving', 'Clearwater Adventures',
   'An SSI dive center in West Bay. A monthly pass for people who live here and dive regularly.',
   'West Bay, Roatán', null, '+504 9625-9618', '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000bb', 'business', 'print_design', 'CC Print & Design',
   'Printing for island businesses on one monthly bill, with one design revision included.',
   null, null, null, '{}', 'inactive', false, null, 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000bc', 'pantry', 'drinks', 'Coco Monkey',
   'Coconut water dropped off on a fixed day each week, for homes, offices and colivings.',
   null, null, null, array['delivery'], 'inactive', false,
   'One scheduled drop a week. Day and areas to be confirmed with Coco Monkey.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000bd', 'pantry', 'local_produce', 'Roatan Fruit Dealer',
   'A basket of produce every week, or a custom fruit basket when you need one.',
   null, null, null, array['delivery'], 'inactive', false,
   'Delivered weekly. Day and areas to be confirmed with Roatan Fruit Dealer.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000be', 'pantry', 'household', 'Roatan Provision',
   'Office snacks and drinks, household essentials and cleaning supplies, delivered on a schedule.',
   null, null, null, array['delivery'], 'inactive', false,
   'Delivered on a set schedule. Areas to be confirmed with Roatan Provision.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000bf', 'pantry', 'coffee', 'Spirit Origin Coffee',
   'Specialty coffee roasted at origin at the First Bight roastery, delivered on the island.',
   'First Bight, Roatán',
   '[{"days":["MO","TU","WE","TH","FR","SA","SU"],"open":"07:00","close":"21:00"}]'::jsonb,
   null, array['delivery'], 'inactive', false,
   'Delivered on the island each month. Areas to be confirmed with Spirit Origin.', 'marketplace'),

  ('5a1e0000-0000-4000-8000-0000000000c0', 'clubs', 'gym', 'Adrian''s Gym',
   'Gym membership, personal training and a plan for households and teams.',
   null, null, null, '{}', 'inactive', false, null, 'marketplace')
on conflict (id) do nothing;

insert into public.provider_plans (
  provider_id, name, description, price_cents, currency, period, status, sort_order,
  pricing_mode, fulfilment, included_quantity, included_unit, features,
  periods_min, periods_default, periods_max, visibility
)
select v.provider_id::uuid, v.name, v.description, v.price_cents, 'USD', v.period, 'inactive', v.sort_order,
       'flat', v.fulfilment, v.qty, v.unit, v.features::jsonb,
       1, 1, case when v.period = 'one_time' then 1 else 6 end, 'public'
from (values
  ('5a1e0000-0000-4000-8000-0000000000b1','Coffee Club · 20 coffees','Twenty coffees a month at the café, paid once.',7000,'monthly',10,'none',20,'coffee','["20 coffees a month","Hot or iced","Show your pass at the counter"]'),
  ('5a1e0000-0000-4000-8000-0000000000b1','Beans to your door','A bag of beans delivered every week.',6000,'monthly',20,'deliveries',4,'bag','["1 bag a week","Delivered on a set day","Pause or cancel any month"]'),

  ('5a1e0000-0000-4000-8000-0000000000b2','Diving Pass · 4 dives','Four boat dives a month.',18000,'monthly',10,'none',4,'dive','["4 boat dives a month","Certified divers"]'),
  ('5a1e0000-0000-4000-8000-0000000000b2','Diving Pass · 8 dives','Eight boat dives a month.',32000,'monthly',20,'none',8,'dive','["8 boat dives a month","Certified divers"]'),

  -- Scuba Shop publishes $40/dive at 3+ tanks and $350 for ten: both passes sit at or below that.
  ('5a1e0000-0000-4000-8000-0000000000b4','Diving Pass · 4 dives','Four dives a month, gear included.',15000,'monthly',10,'none',4,'dive','["4 dives a month","Gear included","Certified divers"]'),
  ('5a1e0000-0000-4000-8000-0000000000b4','Diving Pass · 8 dives','Eight dives a month, gear included.',28000,'monthly',20,'none',8,'dive','["8 dives a month","Gear included","Certified divers"]'),

  -- Pete's Place publishes $35 for a range package and $105 for a half day of 9 holes.
  ('5a1e0000-0000-4000-8000-0000000000b5','Range Club · 4 baskets','Four baskets of 50 balls a month.',10500,'monthly',10,'none',4,'basket','["4 baskets of 50 balls a month","Clubs included"]'),
  ('5a1e0000-0000-4000-8000-0000000000b5','Golf · 4 rounds of 9','Four rounds of nine holes a month, if the course agrees.',34000,'monthly',20,'none',4,'round','["4 rounds of 9 holes a month","Clubs and cart included"]'),

  ('5a1e0000-0000-4000-8000-0000000000b6','Honey for the Year','A jar of raw honey every month for a year.',14400,'yearly',10,'deliveries',12,'jar','["1 jar a month for 12 months","Raw and unfiltered","No added sugar"]'),
  ('5a1e0000-0000-4000-8000-0000000000b6','Jam Monthly','Two jars of mango jam every month.',1400,'monthly',20,'deliveries',2,'jar','["2 × 7 oz jars a month","Creole mango with honey"]'),

  ('5a1e0000-0000-4000-8000-0000000000b7','Beer Monthly · 12 bottles','Twelve bottles of island beer every month.',4800,'monthly',10,'deliveries',12,'bottle','["12 bottles a month","Delivered on a set day","Adults only"]'),
  ('5a1e0000-0000-4000-8000-0000000000b7','Bulk Delivery · 24 bottles','Twenty-four bottles delivered once, for an event or a stock-up.',8500,'one_time',20,'deliveries',24,'bottle','["24 bottles, one delivery","Pick the date","Adults only"]'),

  ('5a1e0000-0000-4000-8000-0000000000b8','Resident Pool & Meals','Pool access with up to $100 of meal credits a month.',15000,'monthly',10,'none',null,null,'["Pool access for residents","Up to $100 of meal credits a month","Credits do not roll over"]'),

  ('5a1e0000-0000-4000-8000-0000000000b9','Resident Swim Pass','Monthly access to the pool for one island resident.',6000,'monthly',10,'none',null,null,'["Pool access for one resident","Show your pass at reception"]'),

  ('5a1e0000-0000-4000-8000-0000000000ba','Diving Pass · 4 dives','Four dives a month.',18000,'monthly',10,'none',4,'dive','["4 dives a month","Certified divers"]'),
  ('5a1e0000-0000-4000-8000-0000000000ba','Diving Pass · 8 dives','Eight dives a month.',32000,'monthly',20,'none',8,'dive','["8 dives a month","Certified divers"]'),

  ('5a1e0000-0000-4000-8000-0000000000bb','Monthly Print Allowance','A set print allowance each month, with one design revision.',7500,'monthly',10,'none',null,null,'["Monthly print allowance","1 design revision included"]'),

  ('5a1e0000-0000-4000-8000-0000000000bc','Weekly Drop · Home','Six coconut waters on one scheduled drop a week.',6000,'monthly',10,'deliveries',24,'bottle','["6 bottles a week","One scheduled drop","Pause or cancel any month"]'),
  ('5a1e0000-0000-4000-8000-0000000000bc','Standing Order · Office or Coliving','Twenty-four coconut waters on one scheduled drop a week.',20000,'monthly',20,'deliveries',96,'bottle','["24 bottles a week","One scheduled drop","One bill a month"]'),

  ('5a1e0000-0000-4000-8000-0000000000bd','Weekly Produce Basket','A basket of produce every week.',10000,'monthly',10,'deliveries',4,'basket','["1 basket a week","Delivered on a set day","Pause or cancel any month"]'),
  ('5a1e0000-0000-4000-8000-0000000000bd','Custom Fruit Basket','One fruit basket made to order.',4500,'one_time',20,'deliveries',1,'basket','["Made to order","Pick the date"]'),

  ('5a1e0000-0000-4000-8000-0000000000be','Office Snacks & Drinks','Snacks and nonalcoholic drinks for the office every month.',18000,'monthly',10,'deliveries',1,'box','["Monthly delivery","Snacks and nonalcoholic drinks"]'),
  ('5a1e0000-0000-4000-8000-0000000000be','Household Essentials','Household essentials delivered every week.',6000,'weekly',20,'deliveries',1,'box','["Weekly delivery","Household essentials"]'),
  ('5a1e0000-0000-4000-8000-0000000000be','Coliving Cleaning Supplies','A cleaning-supply pack for a coliving every month.',9000,'monthly',30,'deliveries',1,'pack','["Monthly delivery","Cleaning supplies for a coliving"]'),

  ('5a1e0000-0000-4000-8000-0000000000bf','Coffee Monthly · 1 bag','One bag of coffee delivered every month.',2800,'monthly',10,'deliveries',1,'bag','["1 bag a month","Roasted in First Bight"]'),
  ('5a1e0000-0000-4000-8000-0000000000bf','Coffee Monthly · 2 bags','Two bags of coffee delivered every month.',5000,'monthly',20,'deliveries',2,'bag','["2 bags a month","Roasted in First Bight"]'),

  ('5a1e0000-0000-4000-8000-0000000000c0','Membership','Monthly gym membership.',5000,'monthly',10,'none',null,null,'["Gym access","Billed monthly"]'),
  ('5a1e0000-0000-4000-8000-0000000000c0','Personal Training · 4 sessions','A defined pack of four personal-training sessions.',14000,'one_time',20,'none',4,'session','["4 sessions","Book with your trainer"]'),
  ('5a1e0000-0000-4000-8000-0000000000c0','Household or Team · 4 people','Membership for four people, on terms the gym approves.',16000,'monthly',30,'none',4,'person','["4 people","Terms set by the gym"]')
) as v(provider_id, name, description, price_cents, period, sort_order, fulfilment, qty, unit, features)
where not exists (
  select 1 from public.provider_plans p
  where p.provider_id = v.provider_id::uuid and p.name = v.name
);
