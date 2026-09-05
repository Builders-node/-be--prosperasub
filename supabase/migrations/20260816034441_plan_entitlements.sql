-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816034441 · plan_entitlements

-- A plan is a set of entitlements, not a single thing.
--
-- Today a plan has exactly one `included_quantity` + `included_unit`, so it can
-- say "4 cleanings a month" and nothing else. It cannot say "4 cleanings AND 2
-- deep cleans", it cannot say "membership plus 4 court hours", and it has no
-- way to distinguish unlimited ACCESS (the beach membership, whose quantity is
-- simply null) from a counted allowance.
--
-- Each entry is one line of what the customer gets:
--
--   {"unit": "cleaning", "quantity": 4,    "period": "monthly", "resource_ids": []}
--   {"unit": "hour",     "quantity": 4,    "period": "monthly", "resource_ids": ["<court>"]}
--   {"unit": "access",   "quantity": null, "period": null,      "resource_ids": []}
--
-- `quantity: null` is unlimited. `period: null` inherits the plan's own.
-- `resource_ids` empty means every bookable resource the provider has — the
-- same rule the plan-level list already uses.
--
-- Nothing reads this yet. The backfill below gives every existing plan exactly
-- one line describing what it already does, so the first reader can fall back
-- to the legacy columns and get the identical answer either way.
alter table public.provider_plans
  add column if not exists entitlements jsonb not null default '[]'::jsonb;

comment on column public.provider_plans.entitlements is
  'What the plan grants, one line per thing: {unit, quantity (null = unlimited), period (null = the plan''s), resource_ids (empty = all)}. Empty array = fall back to included_quantity/included_unit.';

-- One line per plan, from what it already says.
update public.provider_plans p
   set entitlements = jsonb_build_array(
         jsonb_build_object(
           'unit',     coalesce(p.included_unit, case
                          when p.fulfilment = 'deliveries' then 'delivery'
                          when p.fulfilment = 'visits' then 'visit'
                          when p.fulfilment = 'resource_hours' then 'hour'
                          else 'access' end),
           'quantity', p.included_quantity,
           'period',   null,
           'resource_ids', coalesce(p.resource_ids, '[]'::jsonb)
         )
       ),
       updated_at = now()
 where jsonb_array_length(p.entitlements) = 0;
