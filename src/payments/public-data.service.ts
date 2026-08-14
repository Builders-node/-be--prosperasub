import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";

// Tables exposed through the public data API. Prefix-based allow covers every
// service module; a small set of common tables is allowed explicitly. Sensitive
// audit/security tables are always denied.
const ALLOWED_PREFIXES = ["cleaning_", "food_", "beach_club_"];
const ALLOWED_COMMON = new Set([
  "users", "user_profiles", "user_locations", "user_roles",
  "rbac_roles", "rbac_user_roles",
  "global_settings", "ads", "payment_method_settings",
  "subscription_periods",
]);
const DENIED = new Set([
  "access_verification_logs",
  "subscription_expiration_notifications",
]);

function assertAllowed(table: string) {
  if (!/^[a-z0-9_]+$/.test(table)) throw new BadRequestException("Invalid table name.");
  if (DENIED.has(table)) throw new ForbiddenException(`Table "${table}" is not exposed.`);
  const ok = ALLOWED_COMMON.has(table) || ALLOWED_PREFIXES.some((p) => table.startsWith(p));
  if (!ok) throw new ForbiddenException(`Table "${table}" is not exposed.`);
}

@Injectable()
export class PublicDataService {
  private base() {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new ServiceUnavailableException("Data API is not configured.");
    return { url, key };
  }

  private async call<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const { url, key } = this.base();
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new BadRequestException((body && (body.message || body.hint)) || `Supabase ${res.status}`);
    }
    return body as T;
  }

  /** List rows. `query` is a raw PostgREST query string (filters, select, order, limit…). */
  list(table: string, query: string) {
    assertAllowed(table);
    const q = query ? `?${query}` : "?select=*";
    return this.call(`${encodeURIComponent(table)}${q}`);
  }

  async getOne(table: string, id: string, select = "*") {
    assertAllowed(table);
    const rows = await this.call<any[]>(`${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(select)}&limit=1`);
    return Array.isArray(rows) ? rows[0] ?? null : null;
  }

  insert(table: string, body: unknown) {
    assertAllowed(table);
    return this.call(`${encodeURIComponent(table)}`, { method: "POST", body: JSON.stringify(body) });
  }

  update(table: string, id: string, body: Record<string, unknown>) {
    assertAllowed(table);
    return this.call(`${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  remove(table: string, id: string) {
    assertAllowed(table);
    return this.call(`${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
