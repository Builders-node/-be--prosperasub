import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { SubscriptionSource } from "./subscription-source.port";
import type { AccessStatus, SubscriptionView } from "./subscription-view";

/**
 * ANTI-CORRUPTION LAYER. Translates the legacy per-service subscription tables
 * (cleaning / food / beach_club / car_rental) into the domain's generic
 * `SubscriptionView`. This is the ONLY place in Membership that knows about
 * industry tables — the domain core stays industry-agnostic. When the
 * entitlement read model lands, swap this adapter without touching the domain.
 * (Exempt from the domain-boundary lint by the `.acl.ts` suffix.)
 */
@Injectable()
export class LegacySubscriptionSource implements SubscriptionSource {
  private readonly logger = new Logger(LegacySubscriptionSource.name);

  constructor(private readonly config: ConfigService) {}

  async getSubscriptions(subjectId: string): Promise<SubscriptionView[]> {
    const [cleaning, food, beach, universal] = await Promise.all([
      this.fetchCleaning(subjectId),
      this.fetchFood(subjectId),
      this.fetchBeachClub(subjectId),
      this.fetchUniversal(subjectId),
    ]);
    return [...cleaning, ...food, ...beach, ...universal];
  }

  private async fetchCleaning(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.rest<Array<Record<string, unknown>>>(
      `cleaning_subscriptions?select=id,subscription_status,payment_status,is_active,service_end_date,paid_until,end_date,package_id&user_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null`
    );
    if (!rows?.length) return [];

    const pkgIds = [...new Set(rows.map((r) => r.package_id).filter(Boolean))] as string[];
    const pkgMap = new Map<string, { name: string; providerId: string | null }>();
    if (pkgIds.length) {
      const pkgs = await this.rest<Array<{ id: string; name: string; owner_provider_id: string | null }>>(
        `cleaning_packages?select=id,name,owner_provider_id&id=in.(${pkgIds.map((id) => `"${id}"`).join(",")})`
      );
      (pkgs ?? []).forEach((p) => pkgMap.set(p.id, { name: p.name, providerId: p.owner_provider_id }));
    }
    const provMeta = await this.fetchProviderMeta([...pkgMap.values()].map((p) => p.providerId));

    return rows.map((r) => {
      const expiresAt = (r.service_end_date || r.paid_until || r.end_date) as string | null;
      const paid = r.payment_status === "paid";
      const subStatus = String(r.subscription_status ?? "").toLowerCase();
      const isActive = paid && r.is_active === true && (subStatus === "active" || subStatus === "pending_schedule");
      const pkg = pkgMap.get(r.package_id as string);
      const prov = pkg?.providerId ? provMeta.get(pkg.providerId) : undefined;
      return {
        id: String(r.id),
        service: "cleaning",
        name: pkg?.name || "Cleaning plan",
        status: this.normalizeStatus(subStatus, isActive, expiresAt),
        expires_at: expiresAt,
        provider_name: prov?.name ?? null,
        image_url: prov?.image ?? null,
      };
    });
  }

  private async fetchFood(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.rest<Array<Record<string, unknown>>>(
      `food_subscriptions?select=id,status,started_at,commitment_weeks,meal_plan_id,provider_id&user_id=eq.${encodeURIComponent(userId)}`
    );
    if (!rows?.length) return [];

    // Resolve the actual meal-plan name so the verify page shows the tariff the
    // customer holds ("Weekly Lunch") rather than a generic "Food plan".
    const planIds = [...new Set(rows.map((r) => r.meal_plan_id).filter(Boolean))] as string[];
    const planMap = new Map<string, string>();
    if (planIds.length) {
      const plans = await this.rest<Array<{ id: string; name: string }>>(
        `food_meal_plans?select=id,name&id=in.(${planIds.map((id) => `"${id}"`).join(",")})`
      );
      (plans ?? []).forEach((p) => planMap.set(p.id, p.name));
    }

    // Restaurant name + photo for the verify thumbnail — food keeps its own
    // legacy table, so read it directly rather than through the universal bridge.
    const provIds = [...new Set(rows.map((r) => r.provider_id).filter(Boolean))] as string[];
    const provMap = new Map<string, { name: string; image: string | null }>();
    if (provIds.length) {
      const provs = await this.rest<Array<{ id: string; name: string; image_url: string | null; banner_url: string | null }>>(
        `food_providers?select=id,name,image_url,banner_url&id=in.(${provIds.map((id) => `"${id}"`).join(",")})`
      );
      (provs ?? []).forEach((p) => provMap.set(p.id, { name: p.name, image: p.image_url || p.banner_url || null }));
    }

    return rows.map((r) => {
      const expiresAt = this.addWeeks(r.started_at as string | null, Number(r.commitment_weeks ?? 0));
      const status = String(r.status ?? "").toLowerCase();
      const isActive = status === "active";
      const prov = provMap.get(r.provider_id as string);
      return {
        id: String(r.id),
        service: "food",
        name: planMap.get(r.meal_plan_id as string) || "Food plan",
        status: this.normalizeStatus(status, isActive, expiresAt),
        expires_at: expiresAt,
        provider_name: prov?.name ?? null,
        image_url: prov?.image ?? null,
      };
    });
  }

  private async fetchBeachClub(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.rest<Array<Record<string, unknown>>>(
      `provider_subscriptions?source_service_key=eq.beach` +
      `&select=id,plan_name:metadata->>plan_name,status,payment_status,end_date,provider_id` +
      `&user_id=eq.${encodeURIComponent(userId)}`
    );
    if (!rows?.length) return [];
    const provMeta = await this.fetchProviderMeta(rows.map((r) => r.provider_id as string | null));
    return rows.map((r) => {
      const expiresAt = (r.end_date as string | null) ?? null;
      const status = String(r.status ?? "").toLowerCase();
      const isActive = status === "active" && r.payment_status === "paid";
      const prov = r.provider_id ? provMeta.get(String(r.provider_id)) : undefined;
      return {
        id: String(r.id),
        service: "beach_club",
        name: (r.plan_name as string) || "Beach Club membership",
        status: this.normalizeStatus(status, isActive, expiresAt),
        expires_at: expiresAt,
        provider_name: prov?.name ?? null,
        image_url: prov?.image ?? null,
      };
    });
  }

  /**
   * Universal subscriptions — a provider with no legacy table of its own, sold
   * straight into `provider_subscriptions` with a null `source_service_key`.
   * Beach uses this table too (source_service_key='beach') and is read above;
   * the cleaning/food rows here are a frozen backfill with no readers, so this
   * is scoped to `source_service_key IS NULL` to catch exactly the universal
   * ones. Without this a paid universal customer was denied at the QR gate.
   */
  private async fetchUniversal(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.rest<Array<Record<string, unknown>>>(
      `provider_subscriptions?source_service_key=is.null` +
      `&select=id,plan_name:metadata->>plan_name,status,payment_status,end_date,provider_id` +
      `&user_id=eq.${encodeURIComponent(userId)}`
    );
    if (!rows?.length) return [];
    const provMeta = await this.fetchProviderMeta(rows.map((r) => r.provider_id as string | null));
    return rows.map((r) => {
      const expiresAt = (r.end_date as string | null) ?? null;
      const status = String(r.status ?? "").toLowerCase();
      const isActive = status === "active" && r.payment_status === "paid";
      const prov = r.provider_id ? provMeta.get(String(r.provider_id)) : undefined;
      return {
        id: String(r.id),
        service: "plan",
        name: (r.plan_name as string) || "Subscription",
        status: this.normalizeStatus(status, isActive, expiresAt),
        expires_at: expiresAt,
        provider_name: prov?.name ?? null,
        image_url: prov?.image ?? null,
      };
    });
  }

  /**
   * Universal `providers` → name + best available image, for the verify-page
   * thumbnail and subtitle. Cleaning/beach/universal all bridge to this table;
   * food keeps its own (read inline in fetchFood). Dedupes ids and returns an
   * empty map on no input so callers can `.get()` unconditionally.
   */
  private async fetchProviderMeta(
    ids: Array<string | null>,
  ): Promise<Map<string, { name: string; image: string | null }>> {
    const map = new Map<string, { name: string; image: string | null }>();
    const clean = [...new Set(ids.filter(Boolean))] as string[];
    if (!clean.length) return map;
    const rows = await this.rest<Array<{ id: string; name: string; avatar_url: string | null; banner_url: string | null }>>(
      `providers?select=id,name,avatar_url,banner_url&id=in.(${clean.map((id) => `"${id}"`).join(",")})`
    );
    (rows ?? []).forEach((p) => map.set(p.id, { name: p.name, image: p.avatar_url || p.banner_url || null }));
    return map;
  }

  private normalizeStatus(raw: string, isActive: boolean, expiresAt: string | null): AccessStatus {
    const s = raw.toLowerCase();
    if (s === "trial") return "trial";
    if (s === "cancelled" || s === "canceled") return "canceled";
    if (isActive) {
      if (expiresAt && new Date(expiresAt) < this.today()) return "expired";
      return "active";
    }
    if (s === "expired" || s === "completed" || (expiresAt && new Date(expiresAt) < this.today())) {
      return "expired";
    }
    return "pending";
  }

  private addWeeks(start: string | null, weeks: number): string | null {
    if (!start || !weeks) return null;
    const d = new Date(start);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + weeks * 7);
    return d.toISOString();
  }

  private today(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private async rest<T>(path: string): Promise<T | null> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[membership.acl] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.error(`[membership.acl] ${path} network error: ${(err as Error).message}`);
      return null;
    }
  }
}
