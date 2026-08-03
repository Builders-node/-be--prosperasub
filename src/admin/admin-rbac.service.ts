import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AssignUserRolesDto, CreateRoleDto, UpdateRoleDto } from "./admin-roles.dto";

type RoleRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  is_system: boolean;
  is_admin_role: boolean;
  created_at: Date;
  updated_at: Date;
  permissions: string[] | null;
};

const OWNER_ADMIN_ROLES = new Set(["SUPER_ADMIN"]);

@Injectable()
export class AdminRbacService {
  constructor(private readonly prisma: PrismaService) {}

  async hasPermission(userId: string, tokenRoles: string[], permission: string) {
    if (tokenRoles.some((role) => OWNER_ADMIN_ROLES.has(role))) return true;
    if (!this.prisma.isAvailable()) {
      try { await this.prisma.$connect(); } catch { /* continue */ }
    }
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ allowed: boolean }>>(
        `SELECT EXISTS (
          SELECT 1
          FROM public.rbac_user_roles ur
          JOIN public.rbac_roles r ON r.id = ur.role_id
          JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1
            AND ur.removed_at IS NULL
            AND r.status = 'active'
            AND rp.permission_key = $2
        ) AS allowed`,
        userId,
        permission,
      );
      return Boolean(rows[0]?.allowed);
    } catch {
      return false;
    }
  }

  /** Check if a user has ANY admin-level RBAC role (for guard use without a specific permission). */
  async hasAnyAdminRole(userId: string): Promise<boolean> {
    if (!this.prisma.isAvailable()) {
      try { await this.prisma.$connect(); } catch { /* continue */ }
    }
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ found: boolean }>>(
        `SELECT EXISTS (
          SELECT 1 FROM public.rbac_user_roles ur
          JOIN public.rbac_roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND ur.removed_at IS NULL AND r.is_admin_role = true AND r.status = 'active'
        ) AS found`,
        userId,
      );
      return Boolean(rows[0]?.found);
    } catch {
      return false;
    }
  }

  /**
   * Every permission key the user effectively holds, flattened across all their
   * active admin roles. Owner/super-admin short-circuits to "*" — the caller
   * treats that as "everything" rather than enumerating the catalogue, so a
   * newly-added permission is granted to owners automatically.
   *
   * Powers the frontend route guard + sidebar filtering. Without it the SPA
   * showed every admin page to anyone holding any admin role and only failed
   * at the API call, which reads as a broken page rather than "no access".
   */
  async effectivePermissions(userId: string, tokenRoles: string[]): Promise<string[]> {
    if (tokenRoles.some((role) => OWNER_ADMIN_ROLES.has(role))) return ["*"];
    if (!this.prisma.isAvailable()) {
      try { await this.prisma.$connect(); } catch { /* continue */ }
    }
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ permission_key: string }>>(
        `SELECT DISTINCT rp.permission_key
           FROM public.rbac_user_roles ur
           JOIN public.rbac_roles r ON r.id = ur.role_id
           JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = $1
            AND ur.removed_at IS NULL
            AND r.status = 'active'`,
        userId,
      );
      return rows.map((r) => r.permission_key);
    } catch {
      // Fail closed: no permissions rather than accidental full access.
      return [];
    }
  }

  async listPermissions() {
    if (!this.prisma.isAvailable()) {
      return this.supabaseRest(
        "/rbac_permissions?select=key,category,name,description,isAdminPermission:is_admin_permission&order=category.asc&order=key.asc",
      );
    }
    return this.prisma.$queryRawUnsafe(
      `SELECT key, category, name, description, is_admin_permission AS "isAdminPermission"
       FROM public.rbac_permissions
       ORDER BY category, key`,
    );
  }

  async listRoles() {
    if (!this.prisma.isAvailable()) {
      const [roles, rolePermissions] = await Promise.all([
        this.supabaseRest<RoleRow[]>(
          "/rbac_roles?select=id,slug,name,description,status,is_system,is_admin_role,created_at,updated_at&archived_at=is.null&order=is_system.desc&order=name.asc",
        ),
        this.supabaseRest<Array<{ role_id: string; permission_key: string }>>(
          "/rbac_role_permissions?select=role_id,permission_key&order=permission_key.asc",
        ),
      ]);
      const permissionsByRole = new Map<string, string[]>();
      for (const row of rolePermissions) {
        permissionsByRole.set(row.role_id, [...(permissionsByRole.get(row.role_id) ?? []), row.permission_key]);
      }
      return roles.map((role) => this.toRoleDto({ ...role, permissions: permissionsByRole.get(role.id) ?? [] }));
    }
    const rows = await this.prisma.$queryRawUnsafe<RoleRow[]>(
      `SELECT r.*,
        COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
       FROM public.rbac_roles r
       LEFT JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
       WHERE r.archived_at IS NULL
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.name ASC`,
    );
    return rows.map(this.toRoleDto);
  }

  async listUserRoles(userId: string) {
    if (!this.prisma.isAvailable()) {
      const assignments = await this.supabaseRest<Array<{
        id: string;
        role_id: string;
        assigned_at: string;
        assigned_by: string | null;
      }>>(`/rbac_user_roles?select=id,role_id,assigned_at,assigned_by&user_id=eq.${encodeURIComponent(userId)}&removed_at=is.null&order=assigned_at.desc`);
      const roleIds = assignments.map((assignment) => assignment.role_id);
      if (!roleIds.length) return [];
      const roles = await this.supabaseRest<Array<{
        id: string;
        slug: string;
        name: string;
        description: string | null;
        status: string;
        is_system: boolean;
        is_admin_role: boolean;
      }>>(`/rbac_roles?select=id,slug,name,description,status,is_system,is_admin_role&id=in.(${roleIds.join(",")})`);
      const roleById = new Map(roles.map((role) => [role.id, role]));
      return assignments.map((assignment) => {
        const role = roleById.get(assignment.role_id);
        return {
          assignmentId: assignment.id,
          assignedAt: assignment.assigned_at,
          assignedBy: assignment.assigned_by,
          id: assignment.role_id,
          slug: role?.slug,
          name: role?.name,
          description: role?.description,
          status: role?.status,
          isSystem: role?.is_system,
          isAdminRole: role?.is_admin_role,
        };
      });
    }
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT ur.id AS "assignmentId", ur.assigned_at AS "assignedAt", ur.assigned_by AS "assignedBy",
        r.id, r.slug, r.name, r.description, r.status, r.is_system AS "isSystem", r.is_admin_role AS "isAdminRole"
       FROM public.rbac_user_roles ur
       JOIN public.rbac_roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.removed_at IS NULL
       ORDER BY r.name`,
      userId,
    );
    return rows;
  }

  async listUserRoleHistory(userId: string) {
    if (!this.prisma.isAvailable()) {
      const logs = await this.supabaseRest<Array<{
        id: string;
        action: string;
        role_id: string | null;
        target_user_id: string | null;
        actor_user_id: string | null;
        details: unknown;
        created_at: string;
      }>>(`/rbac_role_audit_logs?select=id,action,role_id,target_user_id,actor_user_id,details,created_at&target_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=50`);
      const roleIds = [...new Set(logs.map((log) => log.role_id).filter(Boolean))] as string[];
      const roles = roleIds.length
        ? await this.supabaseRest<Array<{ id: string; name: string }>>(`/rbac_roles?select=id,name&id=in.(${roleIds.join(",")})`)
        : [];
      const roleById = new Map(roles.map((role) => [role.id, role.name]));
      return logs.map((log) => ({
        id: log.id,
        action: log.action,
        roleId: log.role_id,
        roleName: log.role_id ? roleById.get(log.role_id) ?? null : null,
        targetUserId: log.target_user_id,
        actorUserId: log.actor_user_id,
        actorEmail: null,
        details: log.details,
        createdAt: log.created_at,
      }));
    }
    return this.prisma.$queryRawUnsafe(
      `SELECT l.id, l.action, l.role_id AS "roleId", r.name AS "roleName", l.target_user_id AS "targetUserId",
        l.actor_user_id AS "actorUserId", actor.email AS "actorEmail", l.details, l.created_at AS "createdAt"
       FROM public.rbac_role_audit_logs l
       LEFT JOIN public.rbac_roles r ON r.id = l.role_id
       LEFT JOIN public.users actor ON actor.id::text = l.actor_user_id
       WHERE l.target_user_id = $1
       ORDER BY l.created_at DESC
       LIMIT 50`,
      userId,
    );
  }

  async createRole(input: CreateRoleDto, actorUserId: string, actorRoles: string[]) {
    this.assertCanManageAdminRole(input.isAdminRole, actorRoles);
    const slug = this.slugify(input.name);
    if (!this.prisma.isAvailable()) {
      const created = await this.supabaseRest<Array<{ id: string }>>("/rbac_roles?select=id", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: randomUUID(),
          slug,
          name: input.name.trim(),
          description: input.description ?? null,
          status: input.status,
          is_system: false,
          is_admin_role: Boolean(input.isAdminRole),
        }),
      });
      const roleId = created[0].id;
      await this.replacePermissions(roleId, input.permissions, actorUserId);
      await this.audit("role_created", roleId, null, actorUserId, input);
      return this.getRole(roleId);
    }
    const roleRows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public.rbac_roles (id, slug, name, description, status, is_system, is_admin_role)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, $5)
       RETURNING id`,
      slug,
      input.name.trim(),
      input.description ?? null,
      input.status,
      Boolean(input.isAdminRole),
    );
    const roleId = roleRows[0].id;
    await this.replacePermissions(roleId, input.permissions, actorUserId);
    await this.audit("role_created", roleId, null, actorUserId, input);
    return this.getRole(roleId);
  }

  async updateRole(roleId: string, input: UpdateRoleDto, actorUserId: string, actorRoles: string[]) {
    const existing = await this.getRole(roleId);
    this.assertCanManageAdminRole(existing.isAdminRole || input.isAdminRole, actorRoles);
    const name = input.name?.trim();
    const slug = name ? this.slugify(name) : existing.slug;
    if (!this.prisma.isAvailable()) {
      await this.supabaseRest(`/rbac_roles?id=eq.${roleId}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(name ? { name, slug } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.isAdminRole !== undefined ? { is_admin_role: input.isAdminRole } : {}),
          updated_at: new Date().toISOString(),
        }),
      });
      if (input.permissions) await this.replacePermissions(roleId, input.permissions, actorUserId);
      await this.audit("role_edited", roleId, null, actorUserId, input);
      return this.getRole(roleId);
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE public.rbac_roles
       SET name = COALESCE($2, name),
           slug = COALESCE($3, slug),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           is_admin_role = COALESCE($6, is_admin_role),
           updated_at = now()
       WHERE id = $1`,
      roleId,
      name ?? null,
      slug,
      input.description ?? null,
      input.status ?? null,
      input.isAdminRole ?? null,
    );
    if (input.permissions) await this.replacePermissions(roleId, input.permissions, actorUserId);
    await this.audit("role_edited", roleId, null, actorUserId, input);
    return this.getRole(roleId);
  }

  async archiveRole(roleId: string, actorUserId: string, actorRoles: string[]) {
    const existing = await this.getRole(roleId);
    this.assertCanManageAdminRole(existing.isAdminRole, actorRoles);
    if (existing.isSystem) throw new BadRequestException("System roles cannot be archived.");
    if (!this.prisma.isAvailable()) {
      await this.supabaseRest(`/rbac_roles?id=eq.${roleId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "inactive", archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      await this.supabaseRest(`/rbac_user_roles?role_id=eq.${roleId}&removed_at=is.null`, {
        method: "PATCH",
        body: JSON.stringify({ removed_at: new Date().toISOString(), removed_by: actorUserId }),
      });
      await this.audit("role_archived", roleId, null, actorUserId, {});
      return { ok: true };
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE public.rbac_roles SET status = 'inactive', archived_at = now(), updated_at = now() WHERE id = $1`,
      roleId,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE public.rbac_user_roles SET removed_at = now(), removed_by = $2 WHERE role_id = $1 AND removed_at IS NULL`,
      roleId,
      actorUserId,
    );
    await this.audit("role_archived", roleId, null, actorUserId, {});
    return { ok: true };
  }

  async assignUserRoles(userId: string, input: AssignUserRolesDto, actorUserId: string, actorRoles: string[]) {
    const roleIds = [...new Set(input.roleIds)];

    // Always try the Prisma path first (bypasses RLS, which blocks the anon key on rbac tables).
    // Only fall back to REST if Prisma is definitively unavailable AND the REST call succeeds.
    if (!this.prisma.isAvailable()) {
      try { await this.prisma.$connect(); } catch { /* continue */ }
    }
    try {
      return await this.assignUserRolesViaPrisma(userId, roleIds, actorUserId, actorRoles);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error("[RBAC] failed:", msg, "| userId:", userId, "| roleIds:", roleIds);
      if (err instanceof BadRequestException || err instanceof ForbiddenException) throw err;
      // Surface real error so it's visible in the UI (not just "Internal server error")
      throw new BadRequestException(`Role assignment failed: ${msg}`);
    }
  }

  private async assignUserRolesViaPrisma(userId: string, roleIds: string[], actorUserId: string, actorRoles: string[]) {
    // Validate each role individually (avoids array param issues with pgbouncer)
    const roles: Array<{ id: string; is_admin_role: boolean }> = [];
    for (const roleId of roleIds) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; is_admin_role: boolean }>>(
        `SELECT id::text AS id, is_admin_role FROM public.rbac_roles WHERE id::text = $1 AND archived_at IS NULL`,
        roleId,
      );
      if (rows[0]) roles.push(rows[0]);
    }
    if (roleIds.length > 0 && roles.length !== roleIds.length) throw new BadRequestException("One or more roles were not found.");
    this.assertCanManageAdminRole(roles.some((r) => r.is_admin_role), actorRoles);

    // Get current role assignments
    const current = await this.prisma.$queryRawUnsafe<Array<{ role_id: string }>>(
      `SELECT role_id::text AS role_id FROM public.rbac_user_roles WHERE user_id = $1 AND removed_at IS NULL`,
      userId,
    );
    const currentIds = current.map((r) => r.role_id);
    const removedIds = currentIds.filter((id) => !roleIds.includes(id));
    const addedIds   = roleIds.filter((id) => !currentIds.includes(id));
    const now = new Date().toISOString();

    // Remove roles no longer in the set
    for (const roleId of removedIds) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE public.rbac_user_roles SET removed_at = $1::timestamptz, removed_by = $2 WHERE user_id = $3 AND role_id::text = $4 AND removed_at IS NULL`,
        now, actorUserId, userId, roleId,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO public.rbac_role_audit_logs (id, action, role_id, target_user_id, actor_user_id, details) VALUES (gen_random_uuid(), 'user_role_removed', $1::uuid, $2, $3, '{}'::jsonb)`,
        roleId, userId, actorUserId,
      );
    }

    // Add new roles
    for (const roleId of addedIds) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO public.rbac_user_roles (id, user_id, role_id, assigned_by) VALUES (gen_random_uuid(), $1, $2::uuid, $3) ON CONFLICT DO NOTHING`,
        userId, roleId, actorUserId,
      );
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO public.rbac_role_audit_logs (id, action, role_id, target_user_id, actor_user_id, details) VALUES (gen_random_uuid(), 'user_role_assigned', $1::uuid, $2, $3, '{}'::jsonb)`,
        roleId, userId, actorUserId,
      );
    }

    return this.listUserRoles(userId);
  }

  private async assignUserRolesViaRest(userId: string, roleIds: string[], actorUserId: string, actorRoles: string[]) {
    const isSuperAdmin = actorRoles.some((r) => ["SUPER_ADMIN", "super_admin"].includes(r));
    const now = new Date().toISOString();
    const current = await this.supabaseRest<Array<{ role_id: string }>>(
      `/rbac_user_roles?select=role_id&user_id=eq.${encodeURIComponent(userId)}&removed_at=is.null`,
    );
    const currentIds = current.map((r) => r.role_id);
    const removedIds = currentIds.filter((id) => !roleIds.includes(id));
    const addedIds   = roleIds.filter((id) => !currentIds.includes(id));
    if (removedIds.length) {
      await this.supabaseRest(
        `/rbac_user_roles?user_id=eq.${encodeURIComponent(userId)}&role_id=in.(${removedIds.join(",")})&removed_at=is.null`,
        { method: "PATCH", body: JSON.stringify({ removed_at: now, removed_by: actorUserId }) },
      );
      for (const roleId of removedIds) await this.audit("user_role_removed", roleId, userId, actorUserId, {});
    }
    for (const roleId of addedIds) {
      await this.supabaseRest("/rbac_user_roles", {
        method: "POST",
        body: JSON.stringify({ id: randomUUID(), user_id: userId, role_id: roleId, assigned_by: actorUserId }),
      });
      await this.audit("user_role_assigned", roleId, userId, actorUserId, {});
    }
    return this.listUserRoles(userId);
  }

  private async getRole(roleId: string) {
    if (!this.prisma.isAvailable()) {
      const roles = await this.supabaseRest<RoleRow[]>(
        `/rbac_roles?select=id,slug,name,description,status,is_system,is_admin_role,created_at,updated_at&id=eq.${roleId}`,
      );
      if (!roles[0]) throw new BadRequestException("Role not found.");
      const permissions = await this.supabaseRest<Array<{ permission_key: string }>>(
        `/rbac_role_permissions?select=permission_key&role_id=eq.${roleId}&order=permission_key.asc`,
      );
      return this.toRoleDto({ ...roles[0], permissions: permissions.map((permission) => permission.permission_key) });
    }
    const rows = await this.prisma.$queryRawUnsafe<RoleRow[]>(
      `SELECT r.*,
        COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
       FROM public.rbac_roles r
       LEFT JOIN public.rbac_role_permissions rp ON rp.role_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      roleId,
    );
    if (!rows[0]) throw new BadRequestException("Role not found.");
    return this.toRoleDto(rows[0]);
  }

  private async replacePermissions(roleId: string, permissions: string[], actorUserId: string) {
    if (!this.prisma.isAvailable()) {
      await this.supabaseRest(`/rbac_role_permissions?role_id=eq.${roleId}`, { method: "DELETE" });
      if (permissions.length) {
        await this.supabaseRest("/rbac_role_permissions", {
          method: "POST",
          body: JSON.stringify(permissions.map((permission_key) => ({ id: randomUUID(), role_id: roleId, permission_key }))),
        });
      }
      await this.audit("permission_changed", roleId, null, actorUserId, { permissions });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM public.rbac_role_permissions WHERE role_id = $1`, roleId);
      for (const permission of permissions) {
        await tx.$executeRawUnsafe(
          `INSERT INTO public.rbac_role_permissions (id, role_id, permission_key) VALUES (gen_random_uuid(), $1, $2)`,
          roleId,
          permission,
        );
      }
    });
    await this.audit("permission_changed", roleId, null, actorUserId, { permissions });
  }

  private async audit(action: string, roleId: string | null, targetUserId: string | null, actorUserId: string, details: unknown) {
    if (!this.prisma.isAvailable()) {
      await this.supabaseRest("/rbac_role_audit_logs", {
        method: "POST",
        body: JSON.stringify({
          action,
          role_id: roleId,
          target_user_id: targetUserId,
          actor_user_id: actorUserId,
          details: details ?? {},
        }),
      }).catch(() => undefined);
      await this.supabaseRest("/admin_audit_logs", {
        method: "POST",
        body: JSON.stringify({
          admin_user_id: actorUserId,
          action,
          entity_type: "role",
          entity_id: roleId,
          details: details ?? {},
        }),
      }).catch(() => undefined);
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public.rbac_role_audit_logs (id, action, role_id, target_user_id, actor_user_id, details)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb)`,
      action,
      roleId,
      targetUserId,
      actorUserId,
      JSON.stringify(details ?? {}),
    );
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public.admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
       SELECT $1, $2, 'role', $3, $4::jsonb
       WHERE to_regclass('public.admin_audit_logs') IS NOT NULL`,
      actorUserId,
      action,
      roleId,
      JSON.stringify(details ?? {}),
    ).catch(() => undefined);
  }

  private assertCanManageAdminRole(isAdminRole: boolean | undefined, actorRoles: string[]) {
    if (isAdminRole && !actorRoles.some((role) => OWNER_ADMIN_ROLES.has(role))) {
      throw new ForbiddenException("Only super admins can manage admin-level roles.");
    }
  }

  private slugify(value: string) {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw new BadRequestException("Role name is required.");
    return slug;
  }

  private toRoleDto(row: RoleRow) {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: row.status,
      isSystem: row.is_system,
      isAdminRole: row.is_admin_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      permissions: row.permissions ?? [],
    };
  }

  private async supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
    const anonKey   = (process.env.SUPABASE_ANON_KEY ?? "").trim();
    // Always prefer service role key — it bypasses RLS on all tables
    const apiKey = serviceKey || anonKey;
    if (!baseUrl || !apiKey) throw new Error("Supabase REST is not configured.");
    const isWrite = init.method && init.method !== "GET";
    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(isWrite ? { Prefer: "return=representation" } : {}),
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Supabase REST ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
