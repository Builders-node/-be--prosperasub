-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260812194256 · group_cleaning_sizes_into_one_offer_v2

-- Studio / 1BR / 2BR are one service at three sizes, not three services.
--
-- $79 / $79 / $99, all four cleanings a month, all one provider — three cards
-- where the only question is how big the apartment is.
--
-- The rule is deliberately narrow so nothing gets grouped that shouldn't be:
-- same provider, same frequency, and a real apartment_type (not 'any'). That
-- leaves "Cowork Apartment - Daily" and "- Deep" standing alone, which is
-- right: they differ by how often the cleaner comes, not by size, and a
-- customer choosing between them is choosing a different service.

do $$
declare
  r          record;
  v_offer    uuid;
  v_group    uuid;
  v_label    text;
begin
  for r in
    select c.owner_provider_id as provider_id,
           c.frequency_count, c.frequency_unit
      from public.cleaning_packages c
     where c.status = 'active' and c.deleted_at is null
       and c.owner_provider_id is not null
       and coalesce(c.apartment_type, 'any') <> 'any'
     group by 1, 2, 3
    having count(*) > 1
  loop
    select name into v_label from public.providers where id = r.provider_id;
    if v_label is null then continue; end if;

    select id into v_offer from public.provider_plans
     where provider_id = r.provider_id and name = v_label and parent_plan_id is null;

    if v_offer is null then
      insert into public.provider_plans
        (provider_id, name, description, price_cents, currency, period, status,
         sort_order, source_service_key, features)
      values
        (r.provider_id, v_label,
         'Regular cleaning on a schedule. Pick the size of your apartment.',
         0, 'USD', 'monthly', 'active', 0, 'cleaning', '[]'::jsonb)
      returning id into v_offer;
    end if;

    insert into public.plan_option_groups (plan_id, key, label, sort_order)
    values (v_offer, 'apartment_type', 'Apartment size', 0)
    on conflict (plan_id, key) do update set label = excluded.label
    returning id into v_group;

    insert into public.plan_options (group_id, key, label, sort_order)
    select v_group, c.apartment_type,
           case c.apartment_type
             when 'studio' then 'Studio'
             when '1br'    then '1 bedroom'
             when '2br'    then '2 bedrooms'
             when '3br'    then '3 bedrooms'
             else initcap(c.apartment_type)
           end,
           case c.apartment_type when 'studio' then 0 when '1br' then 1
                                 when '2br' then 2 when '3br' then 3 else 9 end
      from public.cleaning_packages c
     where c.status = 'active' and c.deleted_at is null
       and c.owner_provider_id = r.provider_id
       and c.frequency_count = r.frequency_count and c.frequency_unit = r.frequency_unit
       and coalesce(c.apartment_type, 'any') <> 'any'
     group by c.apartment_type
    on conflict (group_id, key) do update set label = excluded.label;

    update public.provider_plans pp
       set parent_plan_id = v_offer,
           option_keys = jsonb_build_object('apartment_type', c.apartment_type),
           updated_at = now()
      from public.cleaning_packages c
     where c.id::text = pp.source_plan_id::text
       and pp.source_service_key = 'cleaning'
       and pp.provider_id = r.provider_id
       and pp.id <> v_offer
       and c.status = 'active' and c.deleted_at is null
       and c.frequency_count = r.frequency_count and c.frequency_unit = r.frequency_unit
       and coalesce(c.apartment_type, 'any') <> 'any';
  end loop;
end $$;
