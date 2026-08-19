import { Injectable, Logger, NotFoundException } from "@nestjs/common";

/**
 * Saved delivery/service addresses — home addresses, i.e. physical-safety PII.
 * These used to be read and written straight from the browser with the anon
 * key under a permissive RLS policy, so anyone with the (public) anon key could
 * read or tamper with every user's addresses. There is no way to owner-scope
 * that in RLS here: the app uses a custom JWT, so Postgres has no `auth.uid()`.
 * So every location operation now goes through this service, keyed on the
 * authenticated user id from AccountAuthGuard, using the service role — and the
 * table is locked to service-role only.
 */
const WRITABLE = ["label", "residence", "street", "house", "apartment", "area", "notes", "line"] as const;

@Injectable()
export class AccountLocationsService {
  private readonly logger = new Logger(AccountLocationsService.name);

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !key) throw new Error("Supabase REST not configured");
    return fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  private enc(v: string) { return encodeURIComponent(v); }

  /** Keep only the columns a customer may set — never user_id/is_default/id. */
  private clean(input: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const k of WRITABLE) if (k in input) out[k] = (input[k] ?? null);
    return out;
  }

  async list(userId: string) {
    return this.supabaseRest<any[]>(
      `/user_locations?user_id=eq.${this.enc(userId)}&order=is_default.desc,created_at.asc`,
    );
  }

  async create(userId: string, input: Record<string, unknown>) {
    const data = this.clean(input);
    const existing = await this.supabaseRest<any[]>(
      `/user_locations?user_id=eq.${this.enc(userId)}&select=id&limit=1`,
    );
    const makeDefault = input.is_default === true || !(existing?.length);
    if (makeDefault) await this.clearDefaults(userId);
    const rows = await this.supabaseRest<any[]>(`/user_locations`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId, ...data, is_default: makeDefault }),
    });
    const row = rows?.[0];
    if (makeDefault && row) await this.mirrorDefault(userId, (row.line as string) ?? null);
    return row;
  }

  async update(userId: string, id: string, input: Record<string, unknown>) {
    // The user_id filter is the ownership check — a foreign id patches nothing.
    const data = { ...this.clean(input), updated_at: new Date().toISOString() };
    const rows = await this.supabaseRest<any[]>(
      `/user_locations?id=eq.${this.enc(id)}&user_id=eq.${this.enc(userId)}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
    const row = rows?.[0];
    if (!row) throw new NotFoundException("Location not found.");
    if (row.is_default) await this.mirrorDefault(userId, (row.line as string) ?? null);
    return row;
  }

  async remove(userId: string, id: string) {
    const rows = await this.supabaseRest<any[]>(
      `/user_locations?id=eq.${this.enc(id)}&user_id=eq.${this.enc(userId)}`,
      { method: "DELETE" },
    );
    const removed = rows?.[0];
    if (!removed) throw new NotFoundException("Location not found.");
    if (removed.is_default) {
      const next = await this.supabaseRest<any[]>(
        `/user_locations?user_id=eq.${this.enc(userId)}&order=created_at.asc&limit=1`,
      );
      if (next?.length) {
        await this.supabaseRest(`/user_locations?id=eq.${this.enc(next[0].id)}`, {
          method: "PATCH", body: JSON.stringify({ is_default: true }),
        });
        await this.mirrorDefault(userId, next[0].line ?? null);
      } else {
        await this.mirrorDefault(userId, null);
      }
    }
    return { ok: true };
  }

  async setDefault(userId: string, id: string) {
    const rows = await this.supabaseRest<any[]>(
      `/user_locations?id=eq.${this.enc(id)}&user_id=eq.${this.enc(userId)}&select=id,line`,
    );
    if (!rows?.length) throw new NotFoundException("Location not found.");
    await this.clearDefaults(userId);
    await this.supabaseRest(`/user_locations?id=eq.${this.enc(id)}&user_id=eq.${this.enc(userId)}`, {
      method: "PATCH", body: JSON.stringify({ is_default: true }),
    });
    await this.mirrorDefault(userId, rows[0].line ?? null);
    return { ok: true };
  }

  private async clearDefaults(userId: string) {
    await this.supabaseRest(`/user_locations?user_id=eq.${this.enc(userId)}&is_default=eq.true`, {
      method: "PATCH", body: JSON.stringify({ is_default: false }),
    });
  }

  /** Mirror the chosen default into user_profiles for existing delivery readers. */
  private async mirrorDefault(userId: string, line: string | null) {
    try {
      await this.supabaseRest(`/user_profiles?user_id=eq.${this.enc(userId)}`, {
        method: "PATCH", body: JSON.stringify({ default_delivery_address: line }),
      });
    } catch (err) {
      this.logger.warn(`mirrorDefault failed: ${(err as Error).message}`);
    }
  }
}
