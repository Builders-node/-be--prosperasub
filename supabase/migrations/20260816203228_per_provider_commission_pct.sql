-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260816203228 · per_provider_commission_pct

-- The platform's cut is a percentage, per provider.
--
-- It used to be per SERVICE and in three shapes: cleaning was bought in at a
-- fixed $750/month (the platform's "profit" was whatever was left of the
-- revenue), the beach club was $10 per person, and only food was a percentage.
-- Three models meant three ways to be wrong, and none of them could express
-- "this business is on 12% and that one is on 8%".
--
-- One model now: the platform keeps `commission_pct` of what customers paid,
-- and the provider keeps the rest. NULL means "use the platform default"
-- (`global_settings.finance_default_commission_pct`).
alter table public.providers
  add column if not exists commission_pct numeric(5,2);

comment on column public.providers.commission_pct is
  'What the platform keeps of this business''s revenue, in whole percent. NULL falls back to global_settings.finance_default_commission_pct. This is the only commission model — there is no fixed or per-unit take any more.';

-- Everyone starts at 10, the rate food was already on.
update public.providers set commission_pct = 10 where commission_pct is null;

insert into public.global_settings (key, value)
values ('finance_default_commission_pct', '10'::jsonb)
on conflict (key) do update set value = excluded.value;

-- The old per-service model, retired. Values before deletion:
--   finance_cleaning_type=fixed   finance_cleaning_cost_cents=75000
--   finance_beach_type=person     finance_beach_extra_cents=1000
--   finance_food_type=percent     finance_food_commission_pct=10
delete from public.global_settings
where key in (
  'finance_cleaning_type', 'finance_cleaning_cost_cents',
  'finance_beach_type', 'finance_beach_extra_cents',
  'finance_food_type', 'finance_food_commission_pct'
);
