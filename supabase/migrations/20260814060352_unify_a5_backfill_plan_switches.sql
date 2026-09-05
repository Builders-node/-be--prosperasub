-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260814060352 · unify_a5_backfill_plan_switches

-- Classify every existing plan as what it already is. No behaviour changes —
-- nothing reads these columns yet; this is the starting truth phase B builds on.

-- Food: weekly, flat price, delivered.
update provider_plans set
  pricing_mode = coalesce(pricing_mode, 'flat'),
  fulfilment   = coalesce(fulfilment, 'deliveries'),
  periods_default = coalesce(periods_default, 1),
  periods_min     = coalesce(periods_min, 1)
where source_service_key = 'food';

-- Cleaning: monthly, and its four pricing modes map onto two of ours —
-- a fixed monthly price is `flat`, a price per cleaning is `per_unit`. The
-- other two ('calculated_estimate', 'custom_manual') belonged to the B2B half
-- that is now gone, so nothing carries them.
update provider_plans p set
  pricing_mode = coalesce(p.pricing_mode,
    case when c.pricing_mode = 'price_per_cleaning' then 'per_unit' else 'flat' end),
  fulfilment   = coalesce(p.fulfilment, 'visits'),
  periods_default = coalesce(p.periods_default, 1),
  periods_min     = coalesce(p.periods_min, 1)
from cleaning_packages c
where p.source_service_key = 'cleaning' and p.source_plan_id = c.id::text;

-- Any cleaning plan without a legacy twin still gets the shape.
update provider_plans set
  pricing_mode = coalesce(pricing_mode, 'flat'),
  fulfilment   = coalesce(fulfilment, 'visits'),
  periods_default = coalesce(periods_default, 1),
  periods_min     = coalesce(periods_min, 1)
where source_service_key = 'cleaning' and (pricing_mode is null or fulfilment is null);

-- Beach memberships: per person, and access-only — no occurrence is produced.
-- Where the club sells at a markup, that is `derived`, and the two halves of
-- the price come across with it.
update provider_plans p set
  pricing_mode = coalesce(p.pricing_mode,
    case when coalesce(b.extra_per_person_cents, 0) > 0 then 'derived' else 'per_person' end),
  provider_price_cents = coalesce(p.provider_price_cents, b.provider_price_per_person_cents),
  markup_cents         = coalesce(p.markup_cents, b.extra_per_person_cents),
  fulfilment      = coalesce(p.fulfilment, 'none'),
  periods_default = coalesce(p.periods_default, 1),
  periods_min     = coalesce(p.periods_min, 1)
from beach_club_plans b
where p.source_service_key = 'beach' and p.source_plan_id = b.id::text;

-- Universal providers: a plain subscription until someone says otherwise.
update provider_plans set
  pricing_mode = coalesce(pricing_mode, 'flat'),
  fulfilment   = coalesce(fulfilment, 'none'),
  periods_default = coalesce(periods_default, 1),
  periods_min     = coalesce(periods_min, 1)
where source_service_key is null;
