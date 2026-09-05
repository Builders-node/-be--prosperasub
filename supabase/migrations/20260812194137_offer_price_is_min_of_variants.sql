-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812194137 · offer_price_is_min_of_variants

-- An offer's price is the cheapest way in.
--
-- provider_plans.price_cents is NOT NULL and every reader on the platform
-- expects a number there, so an offer cannot simply have none. Making the
-- column nullable would push a null check into every price display; storing a
-- hand-typed number would go stale the first time a provider edits a variant.
--
-- So it is derived: the offer always holds min(price of its active variants),
-- which is exactly the "from $40 / week" the card wants to show. A provider
-- never types it and cannot get it wrong.

create or replace function public.provider_plans_sync_offer_price()
returns trigger
language plpgsql
as $$
declare
  v_parent uuid := coalesce(new.parent_plan_id, old.parent_plan_id);
  v_min    int;
begin
  if v_parent is null then return coalesce(new, old); end if;

  select min(price_cents) into v_min
    from public.provider_plans
   where parent_plan_id = v_parent and status = 'active';

  update public.provider_plans
     set price_cents = coalesce(v_min, 0), updated_at = now()
   where id = v_parent;

  return coalesce(new, old);
end;
$$;

drop trigger if exists provider_plans_offer_price on public.provider_plans;
create trigger provider_plans_offer_price
  after insert or update of price_cents, status, parent_plan_id or delete
  on public.provider_plans
  for each row execute function public.provider_plans_sync_offer_price();
