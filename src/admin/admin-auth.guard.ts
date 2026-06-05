import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { SessionService } from "../auth/session.service";
import { ADMIN_PERMISSION_KEY, type AdminPermissionKey } from "./admin-permissions";
import { AdminRbacService } from "./admin-rbac.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminRequest extends Request {
  adminUser?: {
    id: string;
    roles: string[];
  };
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
    private readonly rbac: AdminRbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = this.readBearerToken(request);

    if (!token) {
      throw new UnauthorizedException("Admin access token is required");
    }

    const payload = this.sessions.verifyAccessToken(token);
    const roles = payload.roles ?? [];
    const requiredPermission = this.reflector.getAllAndOverride<AdminPermissionKey | undefined>(
      ADMIN_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Resolve the actual DB UUID — Google OAuth users have "google-xxxxx" as sub
    let userId = payload.sub;
    if (!UUID_RE.test(userId) && payload.email) {
      const resolved = await this.resolveDbUuidByEmail(payload.email);
      if (resolved) userId = resolved;
    }

    const isSuperAdmin = roles.some((r) => ["SUPER_ADMIN", "super_admin"].includes(r));
    let allowed: boolean;
    if (requiredPermission) {
      // Specific permission check — uses RBAC roles table
      allowed = isSuperAdmin || await this.rbac.hasPermission(userId, roles, requiredPermission);
    } else {
      // General admin check — SUPER_ADMIN JWT role OR any admin RBAC role
      allowed = isSuperAdmin || await this.rbac.hasAnyAdminRole(userId);
    }

    if (!allowed) {
      throw new ForbiddenException("Super admin access is required");
    }

    request.adminUser = {
      id: userId,
      roles,
    };

    return true;
  }

  private async resolveDbUuidByEmail(email: string): Promise<string | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key  = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim() || (process.env.SUPABASE_ANON_KEY ?? "").trim();
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return null;
      const rows = await res.json().catch(() => []);
      return rows?.[0]?.id ?? null;
    } catch { return null; }
  }

  private readBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return null;
    return token;
  }
}
