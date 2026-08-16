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

type FinanceKey = "cleaning" | "beach" | "food";

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
  /** Already requested, approved or sent — anything not rejected. */
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
    const acc = (rows: Array<Record<string, any>> | null, toInput: (r: any) => Recognition) => ({
      revenue: (rows ?? []).reduce((sum, r) => sum + recognizedCents(toInput(r), start, end), 0),
    });

    if (source === "cleaning") {
      if (!legacyId) return { revenue: 0 };
      const pkgs = await this.rest<Array<{ id: string }>>(
        `cleaning_packages?provider_id=eq.${encodeURIComponent(legacyId)}&select=id`);
      const ids = (pkgs ?? []).map((p) => p.id);
      if (!ids.length) return { revenue: 0 };
      const rows = await this.rest<Array<Record<string, any>>>(
        `cleaning_subscriptions?package_id=in.(${ids.join(",")})&payment_status=eq.paid&deleted_at=is.null` +
        `&select=total_price_cents,monthly_price_cents,created_at,service_start_date,service_end_date,start_date,end_date`);
      return acc(rows, (r) => {
        const total = Number(r.total_price_cents || 0);
        const monthly = Number(r.monthly_price_cents || 0);
        const months = monthly > 0 && total >= monthly ? Math.max(1, Math.round(total / monthly)) : 1;
        return {
          totalCents: total || monthly,
          serviceStart: r.service_start_date || r.start_date || r.created_at,
          serviceEnd: r.service_end_date || r.end_date,
          fallbackDays: months * 30,
        };
      });
    }

    if (source === "food") {
      if (!legacyId) return { revenue: 0 };
      const rows = await this.rest<Array<Record<string, any>>>(
        `food_subscriptions?provider_id=eq.${encodeURIComponent(legacyId)}&payment_status=eq.paid` +
        `&status=in.(active,paused,expired)` +
        `&select=weekly_price_cents,commitment_weeks,periods_paid,created_at,started_at`);
      return acc(rows, (r) => {
        const weeks = (r.commitment_weeks || 1) * (r.periods_paid || 1);
        const startDay = r.started_at || r.created_at;
        return {
          totalCents: (r.weekly_price_cents || 0) * weeks,
          serviceStart: startDay,
          serviceEnd: null,
          fallbackDays: weeks * 7,
        };
      });
    }

    if (source === "beach") {
      // Scoped to THIS business, not to the service.
      //
      // `financeSourceFor` answers "beach" for the whole Lifestyle archetype,
      // so an unscoped total handed every provider on it the beach club's
      // revenue — and this figure is the cap the payout request is checked
      // against. Memberships are universal rows; the legacy table is their
      // shadow, and totalling the shadow is how one payment becomes two.
      if (!providerId) return { revenue: 0 };
      const rows = await this.rest<Array<Record<string, any>>>(
        `provider_subscriptions?provider_id=eq.${encodeURIComponent(providerId)}&payment_status=eq.paid` +
        `&select=total_cents:price_cents,created_at,start_date,end_date`);
      return acc(rows, (r) => ({
        totalCents: r.total_cents || 0,
        serviceStart: r.start_date || r.created_at,
        serviceEnd: r.end_date,
        fallbackDays: 30,
      }));
    }

    return { revenue: 0 };
  }

  private financeSourceFor(key: string | null): FinanceKey | null {
    const k = String(key ?? "").toLowerCase();
    if (k === "cleaning") return "cleaning";
    if (k === "food") return "food";
    if (k === "beach" || k === "beach_club" || k === "entertainment") return "beach";
    return null;
  }

  /** Anything not rejected is money already spoken for. */
  private async committed(providerId: string): Promise<number> {
    const rows = await this.rest<Array<{ amount_cents: number }>>(
      `provider_payouts?provider_id=eq.${encodeURIComponent(providerId)}` +
      `&status=in.(requested,approved,paid)&select=amount_cents`);
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
