import { Injectable, Logger } from "@nestjs/common";

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

type TakeType = "percent" | "fixed" | "person";
type FinanceKey = "cleaning" | "beach" | "food";

const TAKE_KEYS: Record<FinanceKey, { valueKey: string; typeKey: string; kind: "cost" | "take" }> = {
  cleaning: { valueKey: "finance_cleaning_cost_cents", typeKey: "finance_cleaning_type", kind: "cost" },
  beach:    { valueKey: "finance_beach_extra_cents",   typeKey: "finance_beach_type",    kind: "take" },
  food:     { valueKey: "finance_food_commission_pct", typeKey: "finance_food_type",     kind: "take" },
};
const DEFAULT_TYPE: Record<FinanceKey, TakeType> = { cleaning: "fixed", beach: "person", food: "percent" };
const DEFAULT_RAW: Record<FinanceKey, number> = { cleaning: 75000, beach: 1000, food: 10 };

const AVG_DAYS_PER_MONTH = 365.25 / 12;
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
}

@Injectable()
export class ProviderEarningsService {
  private readonly logger = new Logger(ProviderEarningsService.name);

  /**
   * All-time, because a payout is against the whole relationship — a provider
   * who under-drew in March can draw it in April.
   */
  async summarize(providerId: string): Promise<EarningsSummary> {
    const provider = await this.rest<Array<{ source_service_key: string | null; source_provider_id: string | null; archetype_key: string | null }>>(
      `providers?id=eq.${encodeURIComponent(providerId)}&select=source_service_key,source_provider_id,archetype_key`,
    );
    const row = provider?.[0];
    const source = this.financeSourceFor(row?.source_service_key ?? row?.archetype_key ?? null);
    const legacyId = row?.source_provider_id ?? null;

    const end = new Date();
    const { revenue, units, serviceDays } = await this.fetchEarned(source, legacyId, ALL_TIME_START, end, providerId);

    const settings = await this.readSettings();
    // Months of SERVICE, not months since an epoch. A per-month rate multiplied
    // by the age of the platform is how a cleaning provider with $1,573 of
    // sales gets told they may withdraw $59,000 — the window has to be the
    // period they actually delivered in.
    const months = serviceDays > 0 ? serviceDays / AVG_DAYS_PER_MONTH : 0;
    const earnedCents = source && serviceDays > 0
      ? this.providerShare(source, settings, revenue, units, months)
      : 0;

    const committedCents = await this.committed(providerId);
    return {
      revenueCents: revenue,
      earnedCents,
      committedCents,
      availableCents: Math.max(0, earnedCents - committedCents),
      financeSource: source,
    };
  }

  // ─── Revenue ────────────────────────────────────────────────────────────────

  private async fetchEarned(
    source: FinanceKey | null,
    legacyId: string | null,
    start: Date,
    end: Date,
    /** The universal `providers.id` — what scopes services whose money lives in the universal tables. */
    providerId?: string,
  ): Promise<{ revenue: number; units: number; serviceDays: number }> {
    const acc = (
      rows: Array<Record<string, any>> | null,
      toInput: (r: any) => Recognition,
      unit?: (r: any) => number,
    ) => {
      let revenue = 0;
      let units = 0;
      // The union would be more precise than the envelope, but a provider with
      // a gap between subscriptions is not being paid a retainer for the gap
      // either — clamped to today so future-dated plans cannot buy months.
      let first = Number.POSITIVE_INFINITY;
      let last = Number.NEGATIVE_INFINITY;
      const todayIdx = dayIndex(end);
      (rows ?? []).forEach((r) => {
        const input = toInput(r);
        const cents = recognizedCents(input, start, end);
        if (cents <= 0) return;
        revenue += cents;
        units += unit ? unit(r) : 1;
        const s = span(input);
        if (s) {
          first = Math.min(first, s.start);
          last = Math.max(last, Math.min(s.end, todayIdx + 1));
        }
      });
      const serviceDays = Number.isFinite(first) && last > first ? last - first : 0;
      return { revenue, units, serviceDays };
    };

    if (source === "cleaning") {
      if (!legacyId) return { revenue: 0, units: 0, serviceDays: 0 };
      const pkgs = await this.rest<Array<{ id: string }>>(
        `cleaning_packages?provider_id=eq.${encodeURIComponent(legacyId)}&select=id`);
      const ids = (pkgs ?? []).map((p) => p.id);
      if (!ids.length) return { revenue: 0, units: 0, serviceDays: 0 };
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
      if (!legacyId) return { revenue: 0, units: 0, serviceDays: 0 };
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
      if (!providerId) return { revenue: 0, units: 0, serviceDays: 0 };
      const rows = await this.rest<Array<Record<string, any>>>(
        `provider_subscriptions?provider_id=eq.${encodeURIComponent(providerId)}&payment_status=eq.paid` +
        `&select=total_cents:price_cents,people:metadata->people,created_at,start_date,end_date`);
      return acc(rows,
        (r) => ({ totalCents: r.total_cents || 0, serviceStart: r.start_date || r.created_at, serviceEnd: r.end_date, fallbackDays: 30 }),
        (r) => r.people || 0);
    }

    return { revenue: 0, units: 0, serviceDays: 0 };
  }

  private providerShare(
    source: FinanceKey,
    settings: Record<string, unknown>,
    revenueCents: number,
    units: number,
    months: number,
  ): number {
    const meta = TAKE_KEYS[source];
    const rawSetting = settings[meta.valueKey];
    const typeSetting = settings[meta.typeKey];
    const type = (typeSetting != null && String(typeSetting) ? String(typeSetting) : DEFAULT_TYPE[source]) as TakeType;
    const raw = rawSetting != null && Number.isFinite(Number(rawSetting)) ? Number(rawSetting) : DEFAULT_RAW[source];

    const amount =
      type === "percent" ? Math.round((revenueCents * raw) / 100)
      : type === "fixed" ? Math.round(raw * Math.max(0, months))
      : Math.round(raw * Math.max(0, units));

    // A `cost` source inverts: the platform buys the service outright, so the
    // agreed price IS the provider's earnings. Two clamps the admin's P&L does
    // not need: never negative, and never more than customers actually paid.
    // The P&L is allowed to show the platform losing money on a contract; a
    // withdrawal limit that exceeds the cash collected is a different thing.
    if (meta.kind === "cost") return Math.max(0, Math.min(amount, revenueCents));
    return Math.max(0, revenueCents - Math.min(amount, revenueCents));
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

  private async rest<T>(path: string): Promise<T | null> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) return null;
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[provider-earnings] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`[provider-earnings] ${path} failed: ${String(err)}`);
      return null;
    }
  }
}
