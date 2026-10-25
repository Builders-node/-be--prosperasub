import { HttpError } from "./http.ts";

/**
 * Port of ProviderEarningsService (backend/src/account/provider-earnings.service.ts):
 * revenue recognised straight-line over each paid service period, minus the
 * platform's commission, minus what is already requested/approved/sending/paid.
 * It caps what a provider may withdraw, so it must say exactly what Nest said.
 */

interface Recognition { totalCents: number; serviceStart: string | Date | null | undefined; serviceEnd?: string | Date | null; fallbackDays?: number }
interface RevenueSource {
  table: string; select: string; scope: "universal" | "legacy"; scopeColumn?: string; where?: string;
  resolveScope?: (legacyId: string) => Promise<string[]>;
  toInput: (row: any) => Recognition;
}

async function rest<T>(path: string): Promise<T> {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const PAGE = 1000;
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
    }).catch(() => null);
    if (!res || !res.ok) {
      console.error(`[provider-earnings] ${path} → ${res?.status ?? "network"}`);
      throw new HttpError(503, "Earnings are unavailable right now.");
    }
    const page = await res.json();
    if (!Array.isArray(page)) return page as T;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows as T;
}

const UNIVERSAL_REVENUE: RevenueSource = {
  table: "provider_subscriptions",
  select: "total_cents:price_cents,created_at,start_date,end_date",
  scope: "universal",
  where: "&payment_status=eq.paid",
  toInput: (r) => ({ totalCents: r.total_cents || 0, serviceStart: r.start_date || r.created_at, serviceEnd: r.end_date, fallbackDays: 30 }),
};
const REVENUE_ALIASES: Record<string, string> = { beach_club: "beach", entertainment: "beach" };
const REVENUE_SOURCES: Record<string, RevenueSource> = {
  cleaning: {
    table: "cleaning_subscriptions",
    select: "total_price_cents,monthly_price_cents,created_at,service_start_date,service_end_date,start_date,end_date",
    scope: "legacy", scopeColumn: "package_id", where: "&payment_status=eq.paid&deleted_at=is.null",
    resolveScope: async (legacyId) => {
      const pkgs = await rest<Array<{ id: string }>>(`cleaning_packages?provider_id=eq.${encodeURIComponent(legacyId)}&select=id`);
      return (pkgs ?? []).map((p) => String(p.id));
    },
    toInput: (r) => {
      const total = Number(r.total_price_cents || 0);
      const monthly = Number(r.monthly_price_cents || 0);
      const months = monthly > 0 && total >= monthly ? Math.max(1, Math.round(total / monthly)) : 1;
      return { totalCents: total || monthly, serviceStart: r.service_start_date || r.start_date || r.created_at, serviceEnd: r.service_end_date || r.end_date, fallbackDays: months * 30 };
    },
  },
  food: {
    table: "food_subscriptions",
    select: "weekly_price_cents,commitment_weeks,periods_paid,created_at,started_at,end_date",
    scope: "legacy", where: "&payment_status=eq.paid&status=in.(active,paused,expired)",
    toInput: (r) => {
      const weeks = (r.commitment_weeks || 1) * (r.periods_paid || 1);
      // A renewal moves started_at to the NEW period while the total covers
      // every period paid. Anchoring the span at end_date and counting back
      // keeps the weeks already delivered in the past, where they happened —
      // from started_at they were all pushed into the future.
      if (r.end_date) {
        return { totalCents: (r.weekly_price_cents || 0) * weeks, serviceStart: addDays(String(r.end_date), -weeks * 7), serviceEnd: String(r.end_date), fallbackDays: weeks * 7 };
      }
      return { totalCents: (r.weekly_price_cents || 0) * weeks, serviceStart: r.started_at || r.created_at, serviceEnd: null, fallbackDays: weeks * 7 };
    },
  },
  beach: UNIVERSAL_REVENUE,
  vehicles: {
    table: "rental_bookings",
    select: "total_cents,created_at,start_date,end_date,rental_days",
    scope: "universal", where: "&payment_status=eq.paid&status=neq.cancelled&deleted_at=is.null",
    toInput: (r) => ({ totalCents: Number(r.total_cents || 0), serviceStart: r.start_date || r.created_at, serviceEnd: r.end_date, fallbackDays: Math.max(1, Number(r.rental_days) || 1) }),
  },
};

const DEFAULT_COMMISSION_PCT = 10;

/**
 * When a provider's money becomes withdrawable — a platform setting
 * (global_settings.finance_payout_basis, Admin → Finance):
 *   "delivered" (default) — straight-line as the service runs, so a customer
 *     who cancels has not already been paid out to the provider;
 *   "paid" — the whole amount as soon as the customer has paid.
 */
export type PayoutBasis = "delivered" | "paid";
export const PAYOUT_BASIS_KEY = "finance_payout_basis";
const addDays = (d: string, n: number) => { const x = new Date(`${d.slice(0, 10)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ALL_TIME_START = new Date(2020, 0, 1);

function dayIndex(input: Date | string): number {
  if (typeof input === "string") {
    const [y, m, d] = input.slice(0, 10).split("-").map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  }
  return Math.floor(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()) / 86_400_000);
}
function span(input: Recognition) {
  if (!input.serviceStart) return null;
  const start = dayIndex(input.serviceStart);
  let end = input.serviceEnd ? dayIndex(input.serviceEnd) : Number.NaN;
  if (!Number.isFinite(end) || end <= start) end = start + Math.max(1, Math.round(input.fallbackDays ?? 1));
  return { start, end };
}
function recognizedCents(input: Recognition, rangeStart: Date, rangeEnd: Date): number {
  if (!input.totalCents) return 0;
  const s = span(input);
  if (!s) return 0;
  const overlap = Math.max(0, Math.min(s.end, dayIndex(rangeEnd) + 1) - Math.max(s.start, dayIndex(rangeStart)));
  if (overlap <= 0) return 0;
  return Math.round((input.totalCents * overlap) / (s.end - s.start));
}

export interface EarningsSummary {
  revenueCents: number; earnedCents: number; committedCents: number; availableCents: number;
  financeSource: string | null; commissionPct: number;
}

export async function summarize(providerId: string): Promise<EarningsSummary & { payoutBasis: PayoutBasis }> {
  const provider = await rest<Array<{ source_service_key: string | null; source_provider_id: string | null; archetype_key: string | null; commission_pct: number | string | null }>>(
    `providers?id=eq.${encodeURIComponent(providerId)}&select=source_service_key,source_provider_id,archetype_key,commission_pct`,
  );
  const row = provider?.[0];
  const k = String(row?.source_service_key ?? row?.archetype_key ?? "").toLowerCase();
  const source = REVENUE_ALIASES[k] ?? (k in REVENUE_SOURCES ? k : null);
  const legacyId = row?.source_provider_id ?? null;

  const src = REVENUE_SOURCES[source ?? ""] ?? UNIVERSAL_REVENUE;
  const scopeId = src.scope === "universal" ? (providerId || legacyId) : legacyId;
  const settings = await rest<Array<{ key: string; value: unknown }>>("global_settings?select=key,value");
  const map: Record<string, unknown> = {};
  (settings ?? []).forEach((r) => { map[r.key] = r.value; });
  const payoutBasis: PayoutBasis = String(map[PAYOUT_BASIS_KEY] ?? "").replace(/"/g, "") === "paid" ? "paid" : "delivered";

  let revenue = 0;
  if (scopeId) {
    let filter: string | null;
    if (src.resolveScope) {
      const ids = await src.resolveScope(scopeId);
      filter = ids.length ? `${src.scopeColumn ?? "provider_id"}=in.(${ids.join(",")})` : null;
    } else {
      filter = `${src.scopeColumn ?? "provider_id"}=eq.${encodeURIComponent(scopeId)}`;
    }
    if (filter) {
      const rows = await rest<Array<Record<string, any>>>(`${src.table}?${filter}${src.where ?? ""}&select=${src.select}`);
      const end = new Date();
      revenue = (rows ?? []).reduce((sum, r) => {
        const input = src.toInput(r);
        // "paid": everything a customer has paid counts, whatever the dates.
        return sum + (payoutBasis === "paid" ? Math.round(input.totalCents || 0) : recognizedCents(input, ALL_TIME_START, end));
      }, 0);
    }
  }

  const fallback = map["finance_default_commission_pct"];
  const commissionPct = row?.commission_pct != null && Number.isFinite(Number(row.commission_pct))
    ? Number(row.commission_pct)
    : fallback != null && Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_COMMISSION_PCT;
  const rate = Math.min(Math.max(commissionPct, 0), 100);
  const platformCents = Math.min(Math.round((revenue * rate) / 100), Math.max(0, revenue));
  const earnedCents = Math.max(0, revenue - platformCents);

  const paid = await rest<Array<{ amount_cents: number }>>(
    `provider_payouts?provider_id=eq.${encodeURIComponent(providerId)}&status=in.(requested,approved,sending,paid)&select=amount_cents`,
  );
  const committedCents = (paid ?? []).reduce((s, r) => s + Number(r.amount_cents || 0), 0);
  return {
    revenueCents: revenue, earnedCents, committedCents,
    availableCents: Math.max(0, earnedCents - committedCents),
    financeSource: source, commissionPct: rate, payoutBasis,
  };
}
