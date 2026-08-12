import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "../auth/session.service";

export interface AccountRequest extends Request {
  /** `roles` comes straight off the access token — endpoints that widen access
   *  for staff (payouts, for one) read it rather than re-querying. */
  authUser?: { id: string; email?: string; roles?: string[] };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AccountAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AccountRequest>();
    const token = this.readBearerToken(request);

    if (!token) throw new UnauthorizedException("Access token is required");

    const payload = this.sessions.verifyAccessToken(token);
    let userId = payload.sub;

    // If the JWT sub is a non-UUID (e.g. "google-xxxxx"), resolve the real DB UUID by email
    if (!UUID_RE.test(userId) && payload.email) {
      try {
        const resolved = await this.resolveDbUuidByEmail(payload.email);
        if (resolved) userId = resolved;
      } catch { /* keep original */ }
    }

    request.authUser = { id: userId, email: payload.email, roles: payload.roles ?? [] };
    return true;
  }

  private async resolveDbUuidByEmail(email: string): Promise<string | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) return null;
    const res = await fetch(
      `${base}/rest/v1/users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows?.[0]?.id ?? null;
  }

  private readBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return null;
    return token;
  }
}
