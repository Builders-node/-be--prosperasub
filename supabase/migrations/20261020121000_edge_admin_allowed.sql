-- Applied 20261020121000 · edge_admin_allowed
--
-- The admin guard of the Edge API (backend/supabase/functions/api/lib/auth.ts).
-- Same two questions AdminRbacService asked with raw SQL through Prisma:
--   p_permission given → does any active role of the user carry it?
--   p_permission null  → does the user hold any active admin role?
-- SUPER_ADMIN on the token is decided before this is called.
--
-- service_role only. Granted to nobody else on purpose: a public function in
-- schema public is an anon-callable API (see project memory), and this one
-- answers "is this user an admin".

create or replace function public.edge_admin_allowed(p_user_id text, p_permission text default null)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from rbac_user_roles ur
    join rbac_roles r on r.id = ur.role_id
    where ur.user_id = p_user_id
      and ur.removed_at is null
      and r.status = 'active'
      and (
        (p_permission is null and r.is_admin_role)
        or (p_permission is not null and exists (
          select 1 from rbac_role_permissions rp
          where rp.role_id = r.id and rp.permission_key = p_permission
        ))
      )
  );
$$;

revoke all on function public.edge_admin_allowed(text, text) from public, anon, authenticated;
grant execute on function public.edge_admin_allowed(text, text) to service_role;
