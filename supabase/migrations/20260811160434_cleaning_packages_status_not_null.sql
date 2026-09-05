-- Recovered from the applied migration history (supabase_migrations.schema_migrations).
-- Applied 20260811160434 · cleaning_packages_status_not_null

-- The public listing, the provider page and the /cleaning/packages API each
-- decide visibility with a different subset of four overlapping flags
-- (is_active, status, visibility, deleted_at). The read sites are being
-- unified on status + visibility, and a NULL in either would silently drop a
-- row from `status=eq.active` — a plan that vanishes with no error anywhere.
--
-- Both columns already default to a real value and no row is NULL today
-- (checked: 6/6 rows populated), so this only nails the door shut.

update cleaning_packages set status     = 'active' where status is null;
update cleaning_packages set visibility = 'public' where visibility is null;

alter table cleaning_packages alter column status     set not null;
alter table cleaning_packages alter column visibility set not null;

comment on column cleaning_packages.status is
  'Lifecycle: draft | active | archived. Only "active" is sellable. is_active is the legacy mirror of this and is kept in sync by the admin form.';
comment on column cleaning_packages.visibility is
  'public = listed on the storefront; private = reachable only by direct link / client assignment.';
