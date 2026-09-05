-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816032709 · plan_resource_access

-- Which courts a plan lets you book.
--
-- Membership was all-or-nothing: an active subscription opened every court the
-- club has. A tennis-only membership, a pickleball add-on, or a plan that
-- includes one specific court could not be expressed at all.
--
-- An EMPTY list means every bookable resource this provider has — which is
-- what today's single membership means, and what a provider who never opens
-- this control will keep meaning. Naming courts narrows it; it never widens
-- it, so a plan can only ever grant what its own provider owns.
alter table public.provider_plans
  add column if not exists resource_ids jsonb not null default '[]'::jsonb;

comment on column public.provider_plans.resource_ids is
  'bookable_resources.id values this plan grants access to. Empty = every resource of the plan''s provider. Enforced in BookingService.hold when the provider requires a membership.';

-- A plan may only name resources belonging to its own provider. Enforced here
-- rather than in the editor alone: the editor is one writer of many.
create or replace function public.assert_plan_resources_belong_to_provider()
returns trigger
language plpgsql
as $function$
declare
  v_bad int;
begin
  if new.resource_ids is null or jsonb_array_length(new.resource_ids) = 0 then
    return new;
  end if;
  select count(*) into v_bad
    from jsonb_array_elements_text(new.resource_ids) as x(id)
   where not exists (
     select 1 from public.bookable_resources r
      where r.id::text = x.id and r.provider_id = new.provider_id
   );
  if v_bad > 0 then
    raise exception 'plan % names % resource(s) that do not belong to its provider', new.id, v_bad;
  end if;
  return new;
end;
$function$;

drop trigger if exists provider_plans_resource_ids_guard on public.provider_plans;
create trigger provider_plans_resource_ids_guard
  before insert or update of resource_ids, provider_id on public.provider_plans
  for each row execute function public.assert_plan_resources_belong_to_provider();
