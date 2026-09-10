-- A meal plan that nobody scheduled is a meal nobody cooks.
--
-- `generate_food_occurrences` is called from exactly one place: the
-- "Schedule ahead" button (POST /account/providers/:id/occurrences/generate).
-- There is no cron behind it and never was, so the kitchen's day was only ever
-- as current as the last time a person remembered to press it.
--
-- Today that meant four of five active, paid subscriptions had ZERO upcoming
-- deliveries — the provider's "Today's work" listed one customer out of five,
-- and the three sold in the last few days had nothing at all. 66 occurrences
-- were missing.
--
-- The writers are scattered the way they always are here: the customer's
-- checkout, the provider's own "new subscription" dialog, the renewal
-- endpoint, and the reconcile cron marking a late payment paid. None of them
-- is the right owner, so the database is.

create or replace function public.food_subscription_schedule_days()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only the edge into sellable: an UPDATE that touches an address must not
  -- re-run the generator, and a row that was already active and paid has its
  -- days already.
  if new.status is distinct from 'active' or new.payment_status is distinct from 'paid' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status is not distinct from 'active'
     and old.payment_status is not distinct from 'paid' then
    return new;
  end if;

  -- Never fail the sale over the schedule. The button still exists, and
  -- `on conflict do nothing` inside the generator makes every run repeatable.
  begin
    perform public.generate_food_occurrences(21);
  exception when others then
    raise warning 'food occurrence generation failed for %: %', new.id, sqlerrm;
  end;

  return new;
end $$;

drop trigger if exists food_subscription_schedule_days on public.food_subscriptions;
create trigger food_subscription_schedule_days
  after insert or update of status, payment_status on public.food_subscriptions
  for each row execute function public.food_subscription_schedule_days();

comment on function public.generate_food_occurrences(integer) is
  'Idempotent (on conflict do nothing). Called by the Schedule-ahead button AND by food_subscription_schedule_days when a subscription becomes active+paid.';
