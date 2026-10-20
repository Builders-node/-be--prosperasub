import { jwtVerify } from "jose";
import type { Context } from "hono";
import { db } from "./db.ts";
import { forbidden, HttpError, unauthorized } from "./http.ts";

/**
 * Verifies the SAME access tokens the Nest API issues (HS256, JWT_ACCESS_SECRET),
 * so a signed-in user is signed in on both while endpoints move one by one.
 * Ports AccountAuthGuard and AdminAuthGuard (backend/src/account, backend/src/admin).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthUser {
  id: string;
  email?: string;
  roles: string[];
}

interface AccessPayload {
  sub: string;
  email?: string;
  roles?: string[];
  typ?: string;
}

function secret(): Uint8Array {
  const s = Deno.env.get("JWT_ACCESS_SECRET");
  // Fail closed and loudly: an unset secret must never mean "anyone".
  if (!s || s.length < 32) throw new HttpError(503, "Auth is not configured on this endpoint yet");
  return new TextEncoder().encode(s);
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/** Google logins carry `google-<sub>` as subject; the DB id is found by email. */
async function resolveDbId(sub: string, email?: string): Promise<string> {
  if (UUID_RE.test(sub) || !email) return sub;
  const { data } = await db().from("users").select("id").eq("email", email).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? sub;
}

export async function requireAccount(c: Context): Promise<AuthUser> {
  const token = bearer(c);
  if (!token) throw unauthorized();
  let payload: AccessPayload;
  try {
    ({ payload } = (await jwtVerify(token, secret(), { algorithms: ["HS256"] })) as unknown as {
      payload: AccessPayload;
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw unauthorized("Access token is invalid or expired");
  }
  return {
    id: await resolveDbId(payload.sub, payload.email),
    email: payload.email,
    roles: payload.roles ?? [],
  };
}

const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

/** Admin guard: SUPER_ADMIN on the token, or an active RBAC role (with the permission, if one is named). */
export async function requireAdmin(c: Context, permission?: string): Promise<AuthUser> {
  const user = await requireAccount(c);
  if (isSuperAdmin(user.roles)) return user;
  const { data, error } = await db().rpc("edge_admin_allowed", { p_user_id: user.id, p_permission: permission ?? null });
  if (error || data !== true) throw forbidden("Super admin access is required");
  return user;
}
