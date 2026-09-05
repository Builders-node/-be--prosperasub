-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816062844 · mirror_beach_subscription_to_legacy

-- A beach membership is authored on `provider_subscriptions` from now on; the
-- legacy row follows. Same direction and same reasoning as the calendar and
-- the provider-profile mirrors: readers move one at a time, and until the last
-- one has moved the old row has to stay true.
--
-- It creates the legacy twin as well as updating it, because a membership sold
-- after the cutover has no twin yet — and a reader still on the old table
-- would otherwise simply not see that customer.
create or replace function mirror_beach_subscription_to_legacy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  legacy_plan_id uuid;
  people_count int;
  new_id uuid;
begin
  if new.source_service_key is distinct from 'beach' then
    return new;
  end if;

  select pp.source_plan_id::uuid into legacy_plan_id
    from provider_plans pp where pp.id = new.plan_id;

  people_count := greatest(1, coalesce((new.metadata ->> 'people')::int, 1));

  if new.source_subscription_id is null then
    insert into beach_club_subscriptions (
      plan_id, plan_name, user_id, customer_name, customer_email, customer_whatsapp,
      people, start_date, end_date, price_per_person_cents, total_cents,
      payment_status, payment_method, payment_reference, status, notes,
      cancel_at_period_end, cancel_requested_at
    ) values (
      legacy_plan_id,
      coalesce(new.metadata ->> 'plan_name', 'Beach Club Membership'),
      new.user_id::text,
      new.metadata ->> 'customer_name',
      new.metadata ->> 'customer_email',
      new.customer_whatsapp,
      people_count,
      new.start_date, new.end_date,
      coalesce(new.price_cents, 0) / people_count,
      new.price_cents,
      new.payment_status, new.payment_method, new.payment_reference,
      -- The legacy table never learned the universal vocabulary.
      case new.status when 'pending_payment' then 'pending' else new.status end,
      new.notes, coalesce(new.cancel_at_period_end, false), new.cancel_requested_at
    )
    returning id into new_id;
    new.source_subscription_id := new_id::text;
    return new;
  end if;

  update beach_club_subscriptions set
    plan_id = coalesce(legacy_plan_id, plan_id),
    user_id = new.user_id::text,
    customer_whatsapp = new.customer_whatsapp,
    people = people_count,
    start_date = new.start_date,
    end_date = new.end_date,
    total_cents = new.price_cents,
    price_per_person_cents = coalesce(new.price_cents, 0) / people_count,
    payment_status = new.payment_status,
    payment_method = new.payment_method,
    payment_reference = new.payment_reference,
    status = case new.status when 'pending_payment' then 'pending' else new.status end,
    notes = new.notes,
    cancel_at_period_end = coalesce(new.cancel_at_period_end, false),
    cancel_requested_at = new.cancel_requested_at,
    updated_at = now()
  where id = new.source_subscription_id::uuid;

  return new;
end;
$$;

drop trigger if exists provider_subscriptions_mirror_to_beach on provider_subscriptions;
create trigger provider_subscriptions_mirror_to_beach
  before insert or update on provider_subscriptions
  for each row execute function mirror_beach_subscription_to_legacy();
