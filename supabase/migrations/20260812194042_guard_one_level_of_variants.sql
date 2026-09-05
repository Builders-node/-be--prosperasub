-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812194042 · guard_one_level_of_variants

-- A variant may not itself be an offer, and an offer may not carry option keys.
--
-- One level, on purpose: the customer picks a value on each axis and lands on a
-- price. A variant of a variant has no meaning in that UI and would silently
-- produce a plan nobody can reach.
--
-- This one does NOT swallow its errors, unlike the convenience triggers
-- elsewhere in this schema. A bad write here would corrupt what a customer is
-- offered and what they are charged; failing the insert is the correct outcome.

create or replace function public.provider_plans_check_variant_shape()
returns trigger
language plpgsql
as $$
declare
  v_grandparent uuid;
begin
  if new.parent_plan_id is not null then
    if new.parent_plan_id = new.id then
      raise exception 'A plan cannot be a variant of itself.';
    end if;

    select parent_plan_id into v_grandparent
    from public.provider_plans where id = new.parent_plan_id;

    if v_grandparent is not null then
      raise exception 'Plan variants are one level deep; % is already a variant.', new.parent_plan_id;
    end if;

  elsif new.option_keys is not null then
    -- An offer that carries option keys is a variant that lost its parent.
    raise exception 'option_keys belongs on a variant; this plan has no parent.';
  end if;

  return new;
end;
$$;

drop trigger if exists provider_plans_variant_shape on public.provider_plans;
create trigger provider_plans_variant_shape
  before insert or update of parent_plan_id, option_keys on public.provider_plans
  for each row execute function public.provider_plans_check_variant_shape();
