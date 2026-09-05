-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816195133 · provider_plans_classify_on_insert

-- Every plan says how it is priced and what has to happen after the sale.
--
-- `fulfilment` is read at checkout (`planCheckoutModel.needsAddress`) and NULL
-- reads as "nothing to schedule" — so a delivery plan created after the
-- original backfill would take an order with nowhere to send it. Nothing wrote
-- the column: plans arrive here from three directions (the offer editor, the
-- legacy mirror triggers, backfills), so the default belongs to the table
-- rather than to any one of them.
create or replace function public.provider_plans_classify()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pricing_mode is null then
    new.pricing_mode := 'flat';
  end if;

  if new.fulfilment is null then
    new.fulfilment := case new.source_service_key
      when 'cleaning' then 'visits'
      when 'food'     then 'deliveries'
      else 'none'
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists provider_plans_classify on public.provider_plans;

create trigger provider_plans_classify
  before insert on public.provider_plans
  for each row execute function public.provider_plans_classify();

-- The rows that slipped through before the trigger existed.
update public.provider_plans
set pricing_mode = coalesce(pricing_mode, 'flat'),
    fulfilment = coalesce(fulfilment, case source_service_key
      when 'cleaning' then 'visits'
      when 'food'     then 'deliveries'
      else 'none'
    end)
where pricing_mode is null or fulfilment is null;
