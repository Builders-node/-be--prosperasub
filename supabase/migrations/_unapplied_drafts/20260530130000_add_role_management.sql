BEGIN;

CREATE TABLE IF NOT EXISTS public.rbac_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_system boolean NOT NULL DEFAULT false,
  is_admin_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.rbac_permissions (
  key text PRIMARY KEY,
  category text NOT NULL,
  name text NOT NULL,
  description text,
  is_admin_permission boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rbac_role_permissions (
  role_id uuid NOT NULL REFERENCES public.rbac_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.rbac_permissions(key) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS public.rbac_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  role_id uuid NOT NULL REFERENCES public.rbac_roles(id) ON DELETE CASCADE,
  assigned_by text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_by text,
  removed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS rbac_user_roles_active_unique
  ON public.rbac_user_roles (user_id, role_id)
  WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.rbac_role_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  role_id uuid REFERENCES public.rbac_roles(id) ON DELETE SET NULL,
  target_user_id text,
  actor_user_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rbac_roles_status_idx ON public.rbac_roles(status);
CREATE INDEX IF NOT EXISTS rbac_permissions_category_idx ON public.rbac_permissions(category);
CREATE INDEX IF NOT EXISTS rbac_user_roles_user_idx ON public.rbac_user_roles(user_id, removed_at);
CREATE INDEX IF NOT EXISTS rbac_role_audit_logs_target_idx ON public.rbac_role_audit_logs(target_user_id, created_at DESC);

INSERT INTO public.rbac_permissions (key, category, name, description, is_admin_permission)
VALUES
  ('users.read', 'Users', 'View users', 'View user list and profiles.', true),
  ('users.write', 'Users', 'Manage users', 'Edit, block, and delete users.', true),
  ('clients.read', 'Clients', 'View clients', 'View cleaning clients.', true),
  ('clients.write', 'Clients', 'Manage clients', 'Create and edit cleaning clients.', true),
  ('cleaning_plans.read', 'Cleaning Plans', 'View cleaning plans', 'View public and private cleaning plans.', true),
  ('cleaning_plans.write', 'Cleaning Plans', 'Manage cleaning plans', 'Create, edit, assign, and archive cleaning plans.', true),
  ('subscriptions.read', 'Subscriptions', 'View subscriptions', 'View subscriptions.', true),
  ('subscriptions.write', 'Subscriptions', 'Manage subscriptions', 'Create, edit, cancel, and restore subscriptions.', true),
  ('payments.read', 'Payments', 'View payments', 'View payment records and notification status.', true),
  ('payments.write', 'Payments', 'Manage payments', 'Resend payment notifications and manage payment records.', true),
  ('bookings.read', 'Bookings', 'View bookings', 'View cleaning operations and bookings.', true),
  ('bookings.write', 'Bookings', 'Manage bookings', 'Create, update, complete, and delete bookings.', true),
  ('admin_settings.read', 'Admin Settings', 'View settings', 'View admin settings.', true),
  ('admin_settings.write', 'Admin Settings', 'Manage settings', 'Update admin settings.', true),
  ('role_management.read', 'Role Management', 'View roles', 'View roles, permissions, and role history.', true),
  ('role_management.write', 'Role Management', 'Manage roles', 'Create, edit, archive, and assign roles.', true)
ON CONFLICT (key) DO UPDATE
SET category = EXCLUDED.category,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_admin_permission = EXCLUDED.is_admin_permission;

INSERT INTO public.rbac_roles (slug, name, description, status, is_system, is_admin_role)
VALUES
  ('admin', 'Admin', 'Administrative operator with broad platform access except protected super-admin ownership.', 'active', true, true),
  ('manager', 'Manager', 'Operations manager for clients, plans, subscriptions, bookings, and payments.', 'active', true, true),
  ('cleaner', 'Cleaner', 'Cleaning staff role with booking visibility and completion access.', 'active', true, false),
  ('client', 'Client', 'Customer/client role with no admin panel access by default.', 'active', true, false)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    is_system = EXCLUDED.is_system,
    is_admin_role = EXCLUDED.is_admin_role,
    updated_at = now();

WITH role_map AS (
  SELECT id, slug FROM public.rbac_roles
),
admin_permissions AS (
  SELECT key FROM public.rbac_permissions
),
manager_permissions AS (
  SELECT key FROM public.rbac_permissions
  WHERE key NOT IN ('role_management.write', 'admin_settings.write', 'users.write')
),
cleaner_permissions AS (
  SELECT key FROM public.rbac_permissions
  WHERE key IN ('bookings.read', 'bookings.write', 'clients.read')
)
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT role_map.id, admin_permissions.key
FROM role_map, admin_permissions
WHERE role_map.slug = 'admin'
ON CONFLICT DO NOTHING;

WITH role_map AS (
  SELECT id, slug FROM public.rbac_roles
),
manager_permissions AS (
  SELECT key FROM public.rbac_permissions
  WHERE key NOT IN ('role_management.write', 'admin_settings.write', 'users.write')
)
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT role_map.id, manager_permissions.key
FROM role_map, manager_permissions
WHERE role_map.slug = 'manager'
ON CONFLICT DO NOTHING;

WITH role_map AS (
  SELECT id, slug FROM public.rbac_roles
),
cleaner_permissions AS (
  SELECT key FROM public.rbac_permissions
  WHERE key IN ('bookings.read', 'bookings.write', 'clients.read')
)
INSERT INTO public.rbac_role_permissions (role_id, permission_key)
SELECT role_map.id, cleaner_permissions.key
FROM role_map, cleaner_permissions
WHERE role_map.slug = 'cleaner'
ON CONFLICT DO NOTHING;

INSERT INTO public.rbac_user_roles (user_id, role_id, assigned_by)
SELECT u.id::text, r.id, 'system'
FROM public.users u
JOIN public.user_roles ur ON ur.user_id::text = u.id::text
JOIN public.rbac_roles r ON r.slug = 'admin'
WHERE lower(ur.role::text) = 'super_admin'
ON CONFLICT DO NOTHING;

COMMIT;
