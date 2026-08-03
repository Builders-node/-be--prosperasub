import { BadRequestException, Injectable, Logger } from "@nestjs/common";

/**
 * Server-side CRUD for the admin surfaces that used to write straight to
 * PostgREST from the browser with the anon key.
 *
 * Why this exists: `promo_banners`, `food_residences` and `admin_audit_logs`
 * carry permissive RLS (`FOR ALL TO public`) because the admin UI wrote to them
 * with the anon key. That meant RBAC could not apply — there was no server in
 * the request path to refuse anything, so a role with no `admin_settings.*`
 * permission could still edit ads and locations by driving the same client.
 * Routing those writes through NestJS puts them behind
 * `@RequireAdminPermission` like every other admin mutation.
 *
 * Column allow-lists below are deliberate: the browser sends a whole form
 * object, and we only forward fields we intend to be writable.
 */

const AD_COLUMNS = [
  "title", "label", "badge_text", "cta_text", "link_url", "placement",
  "gradient_from", "gradient_via", "gradient_to",
  "text_color", "badge_bg", "badge_text_color",
  "is_active", "dismissible", "sort_order",
] as const;

// food_residences is deliberately tiny — id, name, sort_order, is_active,
// created_at. No address/notes columns exist, so don't accept them.
const RESIDENCE_COLUMNS = [
  "name", "is_active", "sort_order",
] as const;

function pick<T extends Record<string, unknown>>(src: T, allowed: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

@Injectable()
export class AdminContentService {
  private readonly logger = new Logger(AdminContentService.name);

  // ─── Promo banners (Ads) ──────────────────────────────────────────────

  listAds() {
    return this.rest("/promo_banners?select=*&order=sort_order.asc");
  }

  async createAd(body: Record<string, unknown>, actorUserId: string) {
    const payload = pick(body, AD_COLUMNS);
    this.assertLinkUrl(payload.link_url);
    if (!String(payload.title ?? "").trim()) {
      throw new BadRequestException("title is required");
    }
    const rows = await this.rest<Array<{ id: string }>>("/promo_banners", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const id = rows?.[0]?.id ?? null;
    await this.audit(actorUserId, "create", "ad", id, payload);
    return rows?.[0] ?? null;
  }

  async updateAd(id: string, body: Record<string, unknown>, actorUserId: string) {
    const payload = pick(body, AD_COLUMNS);
    this.assertLinkUrl(payload.link_url);
    payload.updated_at = new Date().toISOString();
    const rows = await this.rest<Array<{ id: string }>>(
      `/promo_banners?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    await this.audit(actorUserId, "edit", "ad", id, payload);
    return rows?.[0] ?? null;
  }

  async deleteAd(id: string, actorUserId: string) {
    await this.rest(`/promo_banners?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    // Delete and the active-toggle used to skip the audit trail entirely — only
    // "save" was logged, and under entity_type "plan", so ad changes could never
    // be isolated in Audit Logs.
    await this.audit(actorUserId, "delete", "ad", id, {});
    return { deleted: true };
  }

  // ─── Residences (Locations) ───────────────────────────────────────────

  listResidences() {
    return this.rest("/food_residences?select=*&order=sort_order.asc");
  }

  async createResidence(body: Record<string, unknown>, actorUserId: string) {
    const payload = pick(body, RESIDENCE_COLUMNS);
    if (!String(payload.name ?? "").trim()) {
      throw new BadRequestException("name is required");
    }
    const rows = await this.rest<Array<{ id: string }>>("/food_residences", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const id = rows?.[0]?.id ?? null;
    await this.audit(actorUserId, "create", "residence", id, payload);
    return rows?.[0] ?? null;
  }

  async updateResidence(id: string, body: Record<string, unknown>, actorUserId: string) {
    const payload = pick(body, RESIDENCE_COLUMNS);
    const rows = await this.rest<Array<{ id: string }>>(
      `/food_residences?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    );
    await this.audit(actorUserId, "edit", "residence", id, payload);
    return rows?.[0] ?? null;
  }

  async deleteResidence(id: string, actorUserId: string) {
    await this.rest(`/food_residences?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    await this.audit(actorUserId, "delete", "residence", id, {});
    return { deleted: true };
  }

  // ─── Audit logs (read) ────────────────────────────────────────────────

  /**
   * Server-side filtered audit log. The page previously pulled a flat
   * `.limit(500)` and filtered in the browser, so anything older than the last
   * 500 events was invisible — and searching for it silently returned nothing
   * rather than saying "not in range".
   */
  async listAuditLogs(params: {
    entityType?: string;
    action?: string;
    from?: string;
    to?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
    const offset = Math.max(Number(params.offset) || 0, 0);

    const filters: string[] = ["select=*"];
    if (params.entityType) filters.push(`entity_type=eq.${encodeURIComponent(params.entityType)}`);
    if (params.action) filters.push(`action=eq.${encodeURIComponent(params.action)}`);
    if (params.from) filters.push(`created_at=gte.${encodeURIComponent(params.from)}`);
    if (params.to) filters.push(`created_at=lte.${encodeURIComponent(params.to)}`);
    if (params.q) {
      const term = `*${params.q}*`;
      filters.push(
        `or=(entity_id.ilike.${encodeURIComponent(term)},entity_type.ilike.${encodeURIComponent(term)},action.ilike.${encodeURIComponent(term)})`,
      );
    }
    filters.push("order=created_at.desc");
    filters.push(`limit=${limit}`, `offset=${offset}`);

    const rows = await this.rest<unknown[]>(`/admin_audit_logs?${filters.join("&")}`, {
      headers: { Prefer: "count=exact" },
    });
    return { rows: rows ?? [], limit, offset };
  }

  /** Distinct entity types + actions, for populating the filter dropdowns. */
  async auditFacets() {
    const [types, actions] = await Promise.all([
      this.rest<Array<{ entity_type: string }>>("/admin_audit_logs?select=entity_type&limit=1000"),
      this.rest<Array<{ action: string }>>("/admin_audit_logs?select=action&limit=1000"),
    ]);
    return {
      entity_types: Array.from(new Set((types ?? []).map((r) => r.entity_type).filter(Boolean))).sort(),
      actions: Array.from(new Set((actions ?? []).map((r) => r.action).filter(Boolean))).sort(),
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /** Reject anything that isn't http(s) — link_url renders into a live
   *  `<a target="_blank">` on the public home page. */
  private assertLinkUrl(value: unknown) {
    if (value == null || value === "") return;
    const raw = String(value).trim();
    if (!/^https?:\/\//i.test(raw)) {
      throw new BadRequestException("link_url must start with http:// or https://");
    }
  }

  private async audit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    details: Record<string, unknown>,
  ) {
    try {
      await this.rest("/admin_audit_logs", {
        method: "POST",
        body: JSON.stringify({
          admin_user_id: actorUserId,
          action,
          entity_type: entityType,
          entity_id: entityId,
          details,
        }),
      });
    } catch (err) {
      // Never fail the mutation because the audit write failed.
      this.logger.warn(`[admin-content.audit] ${action} ${entityType}: ${(err as Error).message}`);
    }
  }

  private async rest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !apiKey) throw new Error("Supabase REST is not configured.");
    const response = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.method && init.method !== "GET" ? { Prefer: "return=representation" } : {}),
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`Supabase REST ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
