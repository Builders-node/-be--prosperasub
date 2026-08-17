/**
 * How many hours a plan includes, and how much of them is left.
 *
 * A plan could already say WHICH calendars it opens; this is the other half —
 * HOW MUCH. Until now `quantity: 4` on an entitlement line was a sentence on a
 * pricing page: nothing counted the fifth booking, so "4 court hours a month"
 * and "unlimited" were the same product.
 *
 * Everything here is pure so the arithmetic that refuses a customer can be
 * tested without a database. The service supplies the plans, the clock and the
 * bookings; this decides.
 */

/** The unit an hour allowance is counted in. */
export const HOUR_UNIT = "hour";

export type AllowancePeriod = "weekly" | "monthly" | "quarterly" | "yearly";

export interface PlanForAllowance {
  /** `provider_plans.id` — used to count one plan once, however many
   *  subscriptions to it a customer holds. */
  id?: string | null;
  /** The plan's billing period, inherited when a line names none. */
  period?: string | null;
  entitlements?: unknown;
}

export interface HourAllowance {
  /** Hours per period, summed across the distinct plans that grant them. */
  limit: number;
  period: AllowancePeriod;
}

const asIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];

const asPeriod = (v: unknown): AllowancePeriod | null => {
  const p = String(v ?? "").toLowerCase();
  return p === "weekly" || p === "monthly" || p === "quarterly" || p === "yearly" ? p : null;
};

/**
 * The hour allowance that applies to one calendar, or null for no limit.
 *
 * Rules, in the order they matter:
 *
 * 1. A line applies when it counts hours AND either names no calendars or
 *    names this one.
 * 2. A line with no quantity is unlimited — and unlimited anywhere means
 *    unlimited, because a customer holding an all-access plan does not lose it
 *    by also holding a capped one.
 * 3. Distinct plans add up. Two memberships of 4 hours are 8; the same plan
 *    twice is still 4, which is why `id` is deduplicated first.
 * 4. The shortest period wins when plans disagree, so "4 a week" and "10 a
 *    month" resolve to the weekly cycle rather than silently granting both.
 */
export function hourAllowanceFor(
  plans: PlanForAllowance[] | null | undefined,
  resourceId: string,
): HourAllowance | null {
  if (!plans?.length) return null;

  const seen = new Set<string>();
  let limit = 0;
  let period: AllowancePeriod | null = null;
  let found = false;

  for (const [index, plan] of plans.entries()) {
    const key = plan.id ?? `#${index}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!Array.isArray(plan.entitlements)) continue;
    for (const raw of plan.entitlements) {
      if (!raw || typeof raw !== "object") continue;
      const line = raw as Record<string, unknown>;
      if (String(line.unit ?? "").toLowerCase() !== HOUR_UNIT) continue;

      const named = asIds(line.resource_ids);
      if (named.length && !named.includes(resourceId)) continue;

      const quantity = Number(line.quantity);
      // Unlimited on any applicable line ends the question.
      if (!Number.isFinite(quantity) || quantity <= 0) return null;

      found = true;
      limit += Math.floor(quantity);
      const linePeriod = asPeriod(line.period) ?? asPeriod(plan.period) ?? "monthly";
      period = period === null ? linePeriod : shorter(period, linePeriod);
    }
  }

  return found ? { limit, period: period ?? "monthly" } : null;
}

const PERIOD_RANK: Record<AllowancePeriod, number> = {
  weekly: 0, monthly: 1, quarterly: 2, yearly: 3,
};

function shorter(a: AllowancePeriod, b: AllowancePeriod): AllowancePeriod {
  return PERIOD_RANK[a] <= PERIOD_RANK[b] ? a : b;
}

/**
 * The window the allowance is counted in, as a calendar period in the
 * platform's timezone — Monday-to-Monday for a week, the 1st for a month.
 *
 * Calendar periods rather than each subscription's own anniversary: "4 hours a
 * week" is a sentence about weeks, the provider's staff think in weeks, and a
 * per-subscription cycle would give two members of the same club different
 * Mondays.
 *
 * `offsetMinutes` is the zone's offset from UTC (Honduras is -360 and does not
 * observe DST, which is why a fixed offset is honest here).
 */
export function periodWindow(
  period: AllowancePeriod,
  now: Date,
  offsetMinutes: number,
): { start: Date; end: Date } {
  // Shift into wall-clock, do calendar arithmetic in UTC, shift back.
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  let startLocal: Date;
  let endLocal: Date;

  if (period === "weekly") {
    // Monday-first, like every other week on this platform.
    const dow = (local.getUTCDay() + 6) % 7;
    startLocal = new Date(Date.UTC(y, m, d - dow));
    endLocal = new Date(Date.UTC(y, m, d - dow + 7));
  } else if (period === "monthly") {
    startLocal = new Date(Date.UTC(y, m, 1));
    endLocal = new Date(Date.UTC(y, m + 1, 1));
  } else if (period === "quarterly") {
    const q = Math.floor(m / 3) * 3;
    startLocal = new Date(Date.UTC(y, q, 1));
    endLocal = new Date(Date.UTC(y, q + 3, 1));
  } else {
    startLocal = new Date(Date.UTC(y, 0, 1));
    endLocal = new Date(Date.UTC(y + 1, 0, 1));
  }

  return {
    start: new Date(startLocal.getTime() - offsetMinutes * 60_000),
    end: new Date(endLocal.getTime() - offsetMinutes * 60_000),
  };
}

/** What a period is called where a customer reads it. */
export function periodLabel(period: AllowancePeriod): string {
  return period === "weekly" ? "this week"
    : period === "monthly" ? "this month"
    : period === "quarterly" ? "this quarter"
    : "this year";
}

export interface BookedSpan { startAt: Date | string; endAt?: Date | string | null }

/**
 * Hours already taken, from the bookings themselves rather than their count.
 *
 * A booking is usually one hour on these calendars, but a resource can be
 * configured with 30- or 90-minute slots, and an allowance of "4 hours" that
 * really means "4 bookings" would quietly hand out six hours to whoever books
 * the longer slot. A span with no end counts as one hour.
 */
export function bookedHours(spans: BookedSpan[] | null | undefined): number {
  if (!spans?.length) return 0;
  const total = spans.reduce((sum, s) => {
    const start = new Date(s.startAt).getTime();
    const end = s.endAt ? new Date(s.endAt).getTime() : NaN;
    const ms = Number.isFinite(end) && end > start ? end - start : 3_600_000;
    return sum + ms;
  }, 0);
  // Two decimals: enough for half-hour slots, and it keeps a float sum from
  // reading as 3.9999999 hours.
  return Math.round((total / 3_600_000) * 100) / 100;
}
