-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260815223241 · provider_plans_visibility

-- A plan a provider can sell without listing it.
--
-- Cleaning has had `visibility` since it needed per-client pricing — two of its
-- packages are private today. Nothing else did, so a provider using the shared
-- editor could only publish: there was no way to quote one customer a plan
-- without putting it on the storefront for everyone.
--
-- Private is unlisted, not secret: it stays out of listings and search, and a
-- direct link still opens and still sells. That is what makes it usable — the
-- provider sends the link to the client it was priced for.
alter table public.provider_plans
  add column if not exists visibility text not null default 'public';

alter table public.provider_plans
  drop constraint if exists provider_plans_visibility_check;
alter table public.provider_plans
  add constraint provider_plans_visibility_check check (visibility in ('public', 'private'));

comment on column public.provider_plans.visibility is
  'public = listed on the storefront; private = reachable by direct link only. Mirrors cleaning_packages.visibility for legacy-backed plans.';

create index if not exists provider_plans_visibility_idx
  on public.provider_plans (provider_id, visibility) where status = 'active';
