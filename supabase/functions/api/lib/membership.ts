import { db } from "./db.ts";

/**
 * Port of backend/src/membership: the access decision (MembershipService.
 * evaluateAccess) and the anti-corruption layer that reads the four
 * subscription sources (LegacySubscriptionSource). Same queries, same status
 * rules — the QR gate must say the same yes/no it said on Nest.
 */

export type AccessStatus = "active" | "trial" | "pending" | "expired" | "canceled";

export interface SubscriptionView {
  id: string;
  service: string;
  name: string;
  status: AccessStatus;
  expires_at: string | null;
  provider_name?: string | null;
  image_url?: string | null;
}

export interface AccessDecision {
  permit: boolean;
  reason: string;
  activeCount: number;
  subscriptions: SubscriptionView[];
}

type Row = Record<string, unknown>;

async function rows(table: string, select: string, filter: (q: any) => any): Promise<Row[]> {
  const { data, error } = await filter(db().from(table).select(select));
  if (error) {
    console.warn(`[membership.acl] ${table} → ${error.message}`);
    return [];
  }
  return (data ?? []) as Row[];
}

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function normalizeStatus(raw: string, isActive: boolean, expiresAt: string | null): AccessStatus {
  const s = raw.toLowerCase();
  if (s === "trial") return "trial";
  if (s === "cancelled" || s === "canceled") return "canceled";
  if (isActive) {
    if (expiresAt && new Date(expiresAt) < today()) return "expired";
    return "active";
  }
  if (s === "expired" || s === "completed" || (expiresAt && new Date(expiresAt) < today())) return "expired";
  return "pending";
}

function addWeeks(start: string | null, weeks: number): string | null {
  if (!start || !weeks) return null;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString();
}

async function providerMeta(ids: Array<string | null>) {
  const map = new Map<string, { name: string; image: string | null }>();
  const clean = [...new Set(ids.filter(Boolean))] as string[];
  if (!clean.length) return map;
  const found = await rows("providers", "id,name,avatar_url,banner_url", (q) => q.in("id", clean));
  for (const p of found) map.set(String(p.id), { name: String(p.name), image: (p.avatar_url || p.banner_url || null) as string | null });
  return map;
}

async function cleaning(userId: string): Promise<SubscriptionView[]> {
  const subs = await rows(
    "cleaning_subscriptions",
    "id,subscription_status,payment_status,is_active,service_end_date,paid_until,end_date,package_id",
    (q) => q.eq("user_id", userId).is("deleted_at", null),
  );
  if (!subs.length) return [];
  const pkgIds = [...new Set(subs.map((r) => r.package_id).filter(Boolean))] as string[];
  const pkgMap = new Map<string, { name: string; providerId: string | null }>();
  if (pkgIds.length) {
    for (const p of await rows("cleaning_packages", "id,name,owner_provider_id", (q) => q.in("id", pkgIds))) {
      pkgMap.set(String(p.id), { name: String(p.name), providerId: (p.owner_provider_id as string | null) ?? null });
    }
  }
  const prov = await providerMeta([...pkgMap.values()].map((p) => p.providerId));
  return subs.map((r) => {
    const expiresAt = (r.service_end_date || r.paid_until || r.end_date) as string | null;
    const subStatus = String(r.subscription_status ?? "").toLowerCase();
    const isActive = r.payment_status === "paid" && r.is_active === true &&
      (subStatus === "active" || subStatus === "pending_schedule");
    const pkg = pkgMap.get(r.package_id as string);
    const p = pkg?.providerId ? prov.get(pkg.providerId) : undefined;
    return {
      id: String(r.id), service: "cleaning", name: pkg?.name || "Cleaning plan",
      status: normalizeStatus(subStatus, isActive, expiresAt), expires_at: expiresAt,
      provider_name: p?.name ?? null, image_url: p?.image ?? null,
    };
  });
}

async function food(userId: string): Promise<SubscriptionView[]> {
  const subs = await rows("food_subscriptions", "id,status,started_at,commitment_weeks,meal_plan_id,provider_id", (q) => q.eq("user_id", userId));
  if (!subs.length) return [];
  const planIds = [...new Set(subs.map((r) => r.meal_plan_id).filter(Boolean))] as string[];
  const planMap = new Map<string, string>();
  if (planIds.length) for (const p of await rows("food_meal_plans", "id,name", (q) => q.in("id", planIds))) planMap.set(String(p.id), String(p.name));
  const provIds = [...new Set(subs.map((r) => r.provider_id).filter(Boolean))] as string[];
  const provMap = new Map<string, { name: string; image: string | null }>();
  if (provIds.length) {
    for (const p of await rows("food_providers", "id,name,image_url,banner_url", (q) => q.in("id", provIds))) {
      provMap.set(String(p.id), { name: String(p.name), image: (p.image_url || p.banner_url || null) as string | null });
    }
  }
  return subs.map((r) => {
    const expiresAt = addWeeks(r.started_at as string | null, Number(r.commitment_weeks ?? 0));
    const status = String(r.status ?? "").toLowerCase();
    const p = provMap.get(r.provider_id as string);
    return {
      id: String(r.id), service: "food", name: planMap.get(r.meal_plan_id as string) || "Food plan",
      status: normalizeStatus(status, status === "active", expiresAt), expires_at: expiresAt,
      provider_name: p?.name ?? null, image_url: p?.image ?? null,
    };
  });
}

/** provider_subscriptions: beach (source 'beach') or universal (source null). */
async function providerSubs(userId: string, beach: boolean): Promise<SubscriptionView[]> {
  const subs = await rows(
    "provider_subscriptions",
    "id,plan_name:metadata->>plan_name,status,payment_status,end_date,provider_id",
    (q) => (beach ? q.eq("source_service_key", "beach") : q.is("source_service_key", null)).eq("user_id", userId),
  );
  if (!subs.length) return [];
  const prov = await providerMeta(subs.map((r) => r.provider_id as string | null));
  return subs.map((r) => {
    const expiresAt = (r.end_date as string | null) ?? null;
    const status = String(r.status ?? "").toLowerCase();
    const isActive = status === "active" && r.payment_status === "paid";
    const p = r.provider_id ? prov.get(String(r.provider_id)) : undefined;
    return {
      id: String(r.id),
      service: beach ? "beach_club" : "plan",
      name: (r.plan_name as string) || (beach ? "Beach Club membership" : "Subscription"),
      status: normalizeStatus(status, isActive, expiresAt), expires_at: expiresAt,
      provider_name: p?.name ?? null, image_url: p?.image ?? null,
    };
  });
}

export async function getSubscriptions(userId: string): Promise<SubscriptionView[]> {
  const [c, f, b, u] = await Promise.all([cleaning(userId), food(userId), providerSubs(userId, true), providerSubs(userId, false)]);
  return [...c, ...f, ...b, ...u];
}

export async function evaluateAccess(userId: string): Promise<AccessDecision> {
  const subscriptions = await getSubscriptions(userId);
  const activeCount = subscriptions.filter((s) => s.status === "active").length;
  const permit = activeCount > 0;
  const reason = permit
    ? `${activeCount} active subscription${activeCount === 1 ? "" : "s"}`
    : subscriptions.length === 0 ? "No subscriptions on file" : "No active subscriptions";
  return { permit, reason, activeCount, subscriptions };
}
