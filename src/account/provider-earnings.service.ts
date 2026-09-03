import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

/**
 * What a provider is owed, computed on the server.
 *
 * The Money tab already showed this number, but a cap the browser calculates
 * is a suggestion — anyone can POST a payout request with a bigger figure. So
 * the arithmetic is duplicated here deliberately, and the request endpoint
 * trusts only this copy.
 *
 * It mirrors `frontend/src/lib/revenueRecognition.ts` and
 * `lib/finance/platformTake.ts`: revenue recognized straight-line across each
 * subscription's service period, then split by the commission model the admin
 * edits in `global_settings`. If the two ever disagree, the provider and the
 * admin are quoting different numbers at each other — which is the failure
 * this shares its defaults to avoid.
 */

type FinanceKey = keyof typeof REVENUE_SOURCES;

/**
 * Where each vertical's money is, said as data.
 *
 * The mirror of the browser's `services/revenue.ts` — the two must move
 * together, because this one is the ceiling a payout request is checked
 * against and that one is the figure a business is shown. They cannot be one
 * file without a shared package, so they are one shape in two places.
 *
 * No entry means the universal path. A service created in /admin/services has
 * none, and that is the configuration, not an omission.
 */
interface RevenueSource {
  table: string;
  select: string;
  scope: "universal" | "legacy";
  scopeColumn?: string;
  /** Extra PostgREST predicates, written as they appear in the query. */
  where?: string;
  /** Ids to match instead of the provider — cleaning's packages. */
  resolveScope?: (
    legacyId: string,
    /** The service's own PostgREST reader, handed in so a descriptor stays data. */
    rest: (path: string) => Promise<any>,
  ) => Promise<string[]>;
  toInput: (row: any) => Recognition;
}

const UNIVERSAL_REVENUE: RevenueSource = {
  table: "provider_subscriptions",
  select: "total_cents:price_cents,created_at,start_date,end_date",
  scope: "universal",
  where: "&payment_status=eq.paid",
  toInput: (r) => ({
    totalCents: r.total_cents || 0,
    serviceStart: r.start_date || r.created_at,
    serviceEnd: r.end_date,
    fallbackDays: 30,
  }),
};

const REVENUE_ALIASES: Record<string, string> = { beach_club: "beach", entertainment: "beach" };

const REVENUE_SOURCES: Record<string, RevenueSource> = {
  cleaning: {
    table: "cleaning_subscriptions",
    select: "total_price_cents,monthly_price_cents,created_at,service_start_date,service_end_date,start_date,end_date",
    scope: "legacy",
    scopeColumn: "package_id",
    where: "&payment_status=eq.paid&deleted_at=is.null",
    // A cleaning subscription names a package, not the business selling it.
    resolveScope: async (legacyId, rest) => {
      const pkgs = await rest(`cleaning_packages?provider_id=eq.${encodeURIComponent(legacyId)}&select=id`);
      return (pkgs ?? []).map((p: { id: string }) => String(p.id));
    },
    toInput: (r) => {
      const total = Number(r.total_price_cents || 0);
      const monthly = Number(r.monthly_price_cents || 0);
      const months = monthly > 0 && total >= monthly ? Math.max(1, Math.round(total / monthly)) : 1;
      return {
        totalCents: total || monthly,
        serviceStart: r.service_start_date || r.start_date || r.created_at,
        serviceEnd: r.service_end_date || r.end_date,
        fallbackDays: months * 30,
      };
    },
  },

  food: {
    table: "food_subscriptions",
    select: "weekly_price_cents,commitment_weeks,periods_paid,created_at,started_at",
    scope: "legacy",
    where: "&payment_status=eq.paid&status=in.(active,paused,expired)",
    toInput: (r) => {
      const weeks = (r.commitment_weeks || 1) * (r.periods_paid || 1);
      return {
        totalCents: (r.weekly_price_cents || 0) * weeks,
        serviceStart: r.started_at || r.created_at,
        serviceEnd: null,
        fallbackDays: weeks * 7,
      };
    },
  },

  // The beach IS the universal path — memberships moved to
  // provider_subscriptions and the legacy table is their shadow, which would
  // be the same money counted twice.
  beach: UNIVERSAL_REVENUE,

  vehicles: {
    table: "rental_bookings",
    select: "total_cents,created_at,start_date,end_date,rental_days",
    scope: "universal",
    where: "&payment_status=eq.paid&status=neq.cancelled&deleted_at=is.null",
    toInput: (r) => ({
      totalCents: Number(r.total_cents || 0),
      serviceStart: r.start_date || r.created_at,
      serviceEnd: r.end_date,
      fallbackDays: Math.max(1, Number(r.rental_days) || 1),
    }),
  },
};


/** The platform's rate when a provider carries none of its own. */
const DEFAULT_COMMISSION_PCT = 10;
const DEFAULT_COMMISSION_KEY = "finance_default_commission_pct";

const ALL_TIME_START = new Date(2020, 0, 1);

function dayIndex(input: Date | string): number {
  if (typeof input === "string") {
    const [y, m, d] = input.slice(0, 10).split("-").map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  }
  return Math.floor(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()) / 86_400_000);
}

interface Recognition {
  totalCents: number;
  serviceStart: string | Date | null | undefined;
  serviceEnd?: string | Date | null;
  fallbackDays?: number;
}

function span(input: Recognition): { start: number; end: number } | null {
  if (!input.serviceStart) return null;
  const start = dayIndex(input.serviceStart);
  let end = input.serviceEnd ? dayIndex(input.serviceEnd) : Number.NaN;
  if (!Number.isFinite(end) || end <= start) {
    end = start + Math.max(1, Math.round(input.fallbackDays ?? 1));
  }
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
  /** Revenue recognized all-time, before the platform's share. */
  revenueCents: number;
  /** The provider's share of it. */
  earnedCents: number;
  /** Requested, approved, in flight or paid — everything except rejected and failed. */
  committedCents: number;
  /** earned − committed, floored at zero. The cap on a payout request. */
  availableCents: number;
  financeSource: FinanceKey | null;
  /** The rate applied, so the Money tab can state it rather than guess. */
  commissionPct: number;
}

@Injectable()
export class ProviderEarningsService {
  private readonly logger = new Logger(ProviderEarningsService.name);

  /**
   * All-time, because a payout is against the whole relationship — a provider
   * who under-drew in March can draw it in April.
   */
  async summarize(providerId: string): Promise<EarningsSummary> {
    const provider = await this.rest<Array<{
      source_service_key: string | null; source_provider_id: string | null;
      archetype_key: string | null; commission_pct: number | string | null;
    }>>(
      `providers?id=eq.${encodeURIComponent(providerId)}` +
      `&select=source_service_key,source_provider_id,archetype_key,commission_pct`,
    );
    const row = provider?.[0];
    const source = this.financeSourceFor(row?.source_service_key ?? row?.archetype_key ?? null);
    const legacyId = row?.source_provider_id ?? null;

    const end = new Date();
    const { revenue } = await this.fetchEarned(source, legacyId, ALL_TIME_START, end, providerId);

    const settings = await this.readSettings();
    const commissionPct = this.commissionPct(row?.commission_pct, settings);
    // One model: the platform keeps its percentage, the business keeps the
    // rest. Clamped to what actually came in, so a rate somebody typed as 150
    // cannot make a provider owe money for a period they earned in.
    const rate = Math.min(Math.max(commissionPct, 0), 100);
    const platformCents = Math.min(Math.round((revenue * rate) / 100), Math.max(0, revenue));
    const earnedCents = Math.max(0, revenue - platformCents);

    const committedCents = await this.committed(providerId);
    return {
      revenueCents: revenue,
      earnedCents,
      committedCents,
      availableCents: Math.max(0, earnedCents - committedCents),
      financeSource: source,
      commissionPct: rate,
    };
  }

  /** The provider's own rate, or the platform's. */
  private commissionPct(providerPct: unknown, settings: Record<string, unknown>): number {
    if (providerPct != null && Number.isFinite(Number(providerPct))) return Number(providerPct);
    const fallback = settings[DEFAULT_COMMISSION_KEY];
    if (fallback != null && Number.isFinite(Number(fallback))) return Number(fallback);
    return DEFAULT_COMMISSION_PCT;
  }

  // ─── Revenue ────────────────────────────────────────────────────────────────

  private async fetchEarned(
    source: FinanceKey | null,
    legacyId: string | null,
    start: Date,
    end: Date,
    /** The universal `providers.id` — what scopes services whose money lives in the universal tables. */
    providerId?: string,
  ): Promise<{ revenue: number }> {
    // Straight-line recognition, same as the admin's finance pages: a
    // three-month plan contributes a third of its value to each month it
    // covers. The old per-unit and per-month models needed a headcount and a
    // span as well; a percentage needs only the money.
    //
    // Every column read below is the PRICE, never the charged total. A payment
    // method's surcharge (PayPal 5%, on-chain 2.5%) is added on top at checkout
    // and stored in `surcharge_cents` of its own — it exists to cover what the
    // processor takes, so it is not revenue and must never reach a payout. Do
    // not "fix" these sums by adding it back.
    const acc = (rows: Array<Record<string, any>> | null, toInput: (r: any) => Recognition) => ({
      revenue: (rows ?? []).reduce((sum, r) => sum + recognizedCents(toInput(r), start, end), 0),
    });

    const src = REVENUE_SOURCES[source ?? ""] ?? UNIVERSAL_REVENUE;
    const scopeId = src.scope === "universal" ? (providerId || legacyId) : legacyId;
    if (!scopeId) return { revenue: 0 };

    // Rows a provider owns indirectly — cleaning's, which name a package
    // rather than the business that sells it.
    let filter: string;
    if (src.resolveScope) {
      const ids = await src.resolveScope(scopeId, (path) => this.rest<Array<Record<string, any>>>(path));
      if (!ids.length) return { revenue: 0 };
      filter = `${src.scopeColumn ?? "provider_id"}=in.(${ids.join(",")})`;
    } else {
      filter = `${src.scopeColumn ?? "provider_id"}=eq.${encodeURIComponent(scopeId)}`;
    }

    const rows = await this.rest<Array<Record<string, any>>>(
      `${src.table}?${filter}${src.where ?? ""}&select=${src.select}`,
    );
    return acc(rows, src.toInput);
  }

  /** Which descriptor a provider's key resolves to; null is the universal one. */
  private financeSourceFor(key: string | null): FinanceKey | null {
    const k = String(key ?? "").toLowerCase();
    return (REVENUE_ALIASES[k] ?? (k in REVENUE_SOURCES ? k : null)) as FinanceKey | null;
  }

  /** Anything not rejected is money already spoken for. */
  private async committed(providerId: string): Promise<number> {
    const rows = await this.rest<Array<{ amount_cents: number }>>(
      `provider_payouts?provider_id=eq.${encodeURIComponent(providerId)}` +
      // `sending` is money Blink has already been told to move. Leaving it out
      // would hand the provider a balance they could request a second time
      // while the first payment was still routing.
      `&status=in.(requested,approved,sending,paid)&select=amount_cents`);
    return (rows ?? []).reduce((sum, r) => sum + Number(r.amount_cents || 0), 0);
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    const rows = await this.rest<Array<{ key: string; value: unknown }>>("global_settings?select=key,value");
    const map: Record<string, unknown> = {};
    (rows ?? []).forEach((r) => { map[r.key] = r.value; });
    return map;
  }

  // ─── PostgREST ──────────────────────────────────────────────────────────────

  /**
   * Every row of `path`, or an exception.
   *
   * Two failures used to be the same thing here. A plain select stops at
   * PostgREST's 1000-row cap and returns HTTP 200, so past that a provider's
   * earnings would simply stop growing; and any error returned `null`, which
   * the callers read as "no subscriptions" — a provider looking at their Money
   * tab during a blip was told they had earned nothing, and the payout cap
   * agreed. Now it pages until a short page, and a failure is a failure.
   */
  private async rest<T>(path: string): Promise<T | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) {
      throw new ServiceUnavailableException("Earnings are unavailable right now.");
    }

    const PAGE = 1000;
    const rows: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      let res: Response;
      try {
        res = await fetch(`${base}/rest/v1/${path}`, {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            Range: `${from}-${from + PAGE - 1}`,
            "Range-Unit": "items",
          },
        });
      } catch (err) {
        this.logger.error(`[provider-earnings] ${path} failed: ${String(err)}`);
        throw new ServiceUnavailableException("Earnings are unavailable right now.");
      }
      if (!res.ok) {
        this.logger.error(`[provider-earnings] ${path} → ${res.status}`);
        throw new ServiceUnavailableException("Earnings are unavailable right now.");
      }
      const page = (await res.json()) as unknown;
      if (!Array.isArray(page)) return page as T;
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows as T;
  }
}
