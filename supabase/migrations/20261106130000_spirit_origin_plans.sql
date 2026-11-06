-- Applied 20261106130000 · spirit_origin_plans
--
-- Spirit Origin's real offers, replacing the placeholder bag plans (which stay
-- inactive): a coffee every day for $69 a month, and 20% off the whole menu —
-- the second has no price yet and is switched off until it does.
-- The provider itself is still a draft (inactive), so neither is listed.

insert into public.provider_plans (
  provider_id, name, description, price_cents, currency, period, status, sort_order,
  pricing_mode, fulfilment, features, periods_min, periods_default, periods_max, visibility
)
select v.provider_id, v.name, v.description, v.price_cents, 'USD', 'monthly', v.status, v.sort_order,
       'flat', 'none', v.features::jsonb, 1, 1, 6, 'public'
from (values
  ('5a1e0000-0000-4000-8000-0000000000bf'::uuid, 'Coffee Every Day',
   'One coffee every day of the month at Spirit Origin in First Bight.',
   6900, 'active', 1, '["1 coffee every day","At the Spirit Origin café, First Bight","Billed monthly"]'),
  ('5a1e0000-0000-4000-8000-0000000000bf'::uuid, '20% Off the Whole Menu',
   '20% off everything on the Spirit Origin menu for the month.',
   0, 'inactive', 2, '["20% off the whole menu","Every visit, all month"]')
) as v(provider_id, name, description, price_cents, status, sort_order, features)
where not exists (
  select 1 from public.provider_plans p where p.provider_id = v.provider_id and p.name = v.name
);
