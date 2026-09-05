-- The public listing, the provider page and the unauthenticated
-- /cleaning/packages API each decided visibility from a different subset of
-- four overlapping flags (is_active, status, visibility, deleted_at). None of
-- them read `status` — the column the admin's Draft / Active / Archived control
-- writes — so Archive removed a badge and nothing else, Duplicate published its
-- draft copy instantly, and the API returned both private Cowork plans to
-- anyone who asked.
--
-- The read sites are unified on status + visibility in the same change. A NULL
-- in either would silently drop a row from `status=eq.active` — a plan that
-- vanishes with no error anywhere — so both are pinned down here. Both already
-- default to a real value and no row was NULL (6/6 populated when applied).
--
-- Applied to production on 2026-08-11 via the Supabase MCP and recorded here.

update cleaning_packages set status     = 'active' where status is null;
update cleaning_packages set visibility = 'public' where visibility is null;

alter table cleaning_packages alter column status     set not null;
alter table cleaning_packages alter column visibility set not null;

comment on column cleaning_packages.status is
  'Lifecycle: draft | active | archived. Only "active" is sellable. is_active is the legacy mirror of this and is kept in sync by the admin form.';
comment on column cleaning_packages.visibility is
  'public = listed on the storefront; private = reachable only by direct link / client assignment.';
