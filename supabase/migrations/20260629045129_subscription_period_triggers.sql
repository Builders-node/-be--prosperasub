-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260629045129 · subscription_period_triggers

-- FOOD
create or replace function public.log_food_subscription_period() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text;
begin
  if NEW.started_at is null then return NEW; end if;
  if TG_OP = 'UPDATE'
     and NEW.started_at is not distinct from OLD.started_at
     and NEW.end_date  is not distinct from OLD.end_date then
    return NEW;
  end if;
  select name into pname from public.food_meal_plans where id = NEW.meal_plan_id;
  insert into public.subscription_periods
    (service, subscription_id, user_id, customer_name, plan_name, started_at, end_date, amount_cents, payment_method, payment_status, source)
  values ('food', NEW.id::text, NEW.user_id::text, NEW.customer_name, pname,
          NEW.started_at, NEW.end_date,
          coalesce(NEW.weekly_price_cents,0) * greatest(coalesce(NEW.commitment_weeks,1),1),
          NEW.payment_method, NEW.payment_status,
          case when TG_OP = 'INSERT' then 'create' else 'renewal' end);
  return NEW;
end $$;
drop trigger if exists trg_food_period on public.food_subscriptions;
create trigger trg_food_period after insert or update on public.food_subscriptions
  for each row execute function public.log_food_subscription_period();

-- CLEANING
create or replace function public.log_cleaning_subscription_period() returns trigger
language plpgsql security definer set search_path = public as $$
declare pname text; eff_start date; eff_end date;
begin
  if NEW.deleted_at is not null then return NEW; end if;
  eff_start := coalesce(NEW.service_start_date, NEW.start_date);
  eff_end   := coalesce(NEW.service_end_date, NEW.paid_until, NEW.end_date);
  if eff_start is null then return NEW; end if;
  if TG_OP = 'UPDATE'
     and NEW.service_start_date is not distinct from OLD.service_start_date
     and NEW.service_end_date   is not distinct from OLD.service_end_date
     and NEW.paid_until         is not distinct from OLD.paid_until
     and NEW.end_date           is not distinct from OLD.end_date
     and NEW.start_date         is not distinct from OLD.start_date then
    return NEW;
  end if;
  select name into pname from public.cleaning_packages where id = NEW.package_id;
  insert into public.subscription_periods
    (service, subscription_id, user_id, customer_name, plan_name, started_at, end_date, amount_cents, payment_method, payment_status, source)
  values ('cleaning', NEW.id::text, NEW.user_id::text, null, coalesce(pname, NEW.admin_notes),
          eff_start, eff_end,
          coalesce(NEW.total_price_cents, NEW.monthly_price_cents, 0),
          NEW.payment_method, NEW.payment_status,
          case when TG_OP = 'INSERT' then 'create' else 'renewal' end);
  return NEW;
end $$;
drop trigger if exists trg_cleaning_period on public.cleaning_subscriptions;
create trigger trg_cleaning_period after insert or update on public.cleaning_subscriptions
  for each row execute function public.log_cleaning_subscription_period();

-- BEACH
create or replace function public.log_beach_subscription_period() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.start_date is null then return NEW; end if;
  if TG_OP = 'UPDATE'
     and NEW.start_date is not distinct from OLD.start_date
     and NEW.end_date   is not distinct from OLD.end_date then
    return NEW;
  end if;
  insert into public.subscription_periods
    (service, subscription_id, user_id, customer_name, plan_name, started_at, end_date, amount_cents, payment_method, payment_status, source)
  values ('beach', NEW.id::text, NEW.user_id::text, NEW.customer_name, NEW.plan_name,
          NEW.start_date, NEW.end_date, coalesce(NEW.total_cents,0),
          NEW.payment_method, NEW.payment_status,
          case when TG_OP = 'INSERT' then 'create' else 'renewal' end);
  return NEW;
end $$;
drop trigger if exists trg_beach_period on public.beach_club_subscriptions;
create trigger trg_beach_period after insert or update on public.beach_club_subscriptions
  for each row execute function public.log_beach_subscription_period();
