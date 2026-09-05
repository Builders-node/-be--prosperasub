-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260810044319 · add_massage_category_and_provider_under_lifestyle

-- Massage joins the Lifestyle archetype (key `entertainment`), alongside the
-- Beach Club. Idempotent — safe to re-run.
--
-- Deliberately UNIVERSAL-ONLY: source_service_key stays null. Every other
-- provider bridges to a legacy per-service table, and the massage_* tables were
-- dropped some time ago. Re-creating them would add a fifth legacy island to a
-- codebase trying to leave them, so its plans live in provider_plans and its
-- subscriptions in provider_subscriptions.
--
-- Platform-owned, matching how "Apartment Cleaning" and "Car Wash" are modelled:
-- the provider IS the service, so nothing here invents a business name. No plans
-- and no prices are seeded — those are an admin's to enter.

insert into service_categories (key, label, icon, accent, sort_order, is_active, archetype_key)
values ('massage', 'Massage', 'flower-2', 'bg-rose-500', 20, true, 'entertainment')
on conflict (key) do update
  set label         = excluded.label,
      icon          = excluded.icon,
      accent        = excluded.accent,
      archetype_key = excluded.archetype_key,
      is_active     = true;

insert into providers (name, description, category_key, archetype_key, status,
                       is_platform_owned, capabilities, sort_order)
select 'Massage',
       'Book a massage at Prospera Village. Choose a plan below.',
       'massage', 'entertainment', 'active', true,
       array['subscription_plans'], 20
where not exists (
  select 1 from providers where archetype_key = 'entertainment' and category_key = 'massage'
);
