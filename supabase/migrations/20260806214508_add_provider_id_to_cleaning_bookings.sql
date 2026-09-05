-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260806214508 · add_provider_id_to_cleaning_bookings

-- A cleaning visit had no provider of its own; it was inferred by walking
-- booking → subscription → package → provider. That breaks the moment a
-- booking has no subscription, which is exactly what an admin creates when
-- they schedule a visit for a customer who paid off-platform: the row exists
-- but the provider's own Bookings list can't find it.
alter table public.cleaning_bookings
  add column if not exists provider_id uuid references public.cleaning_providers(id) on delete set null;

-- Backfill the ones we can still infer, so the column is usable immediately
-- rather than only for rows created from now on.
update cleaning_bookings b
set provider_id = coalesce(s.provider_id, p.provider_id)
from cleaning_subscriptions s
left join cleaning_packages p on p.id::text = s.package_id::text
where b.provider_id is null
  and s.id::text = coalesce(b.cleaning_subscription_id, b.subscription_id)
  and coalesce(s.provider_id, p.provider_id) is not null;

create index if not exists idx_cleaning_bookings_provider
  on public.cleaning_bookings (provider_id);

comment on column public.cleaning_bookings.provider_id is
  'Owning cleaning provider. Set directly so a booking with no subscription (admin-created for an off-platform customer) is still attributable.';
