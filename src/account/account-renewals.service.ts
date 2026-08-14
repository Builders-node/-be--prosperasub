import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  RenewalPaymentMethod,
  SubscriptionRenewalService,
} from "../payments/subscription-renewal.service";

const TZ = "America/Tegucigalpa";
const DAY_MS = 86_400_000;

interface RenewPayload {
  payment_method: RenewalPaymentMethod;
  payment_reference: string;
  amount_cents: number;
  /** Processing fee charged on top of amount_cents (0 when the method is free). */
  surcharge_cents?: number;
  idempotency_key: string;
}

interface CleaningSubRow {
  id: string;
  user_id: string | null;
  subscription_status: string | null;
  start_date: string | null;
  end_date: string | null;
  billing_period_months: number | null;
  monthly_price_cents: number | null;
  total_price_cents: number | null;
  package_id: string | null;
  periods_paid: number | null;
}

interface BeachSubRow {
  id: string;
  user_id: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  total_cents: number | null;
  plan_id: string | null;
  plan_name: string | null;
}

interface PlanSubRow {
  id: string;
  user_id: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  price_cents: number | null;
  plan_id: string | null;
  periods_paid: number | null;
  metadata: Record<string, any> | null;
}

/**
 * User-facing renewal endpoints for cleaning + beach club subscriptions. Both
 * follow the same shape food.service.ts already uses:
 *   1. Verify payment with the provider (no bypass)
 *   2. Insert audit row with idempotency (safe retries)
 *   3. Extend the existing subscription row (no duplicate created)
 *
 * Historically cleaning renewals inserted a NEW cleaning_subscriptions row per
 * renewal; that surfaces as duplicate entries in "My Subscriptions" and
 * disconnects analytics from the original row. The new endpoint extends in
 * place.
 */
@Injectable()
export class AccountRenewalsService {
  private readonly logger = new Logger(AccountRenewalsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly renewals: SubscriptionRenewalService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Cleaning
  // ═══════════════════════════════════════════════════════════════════════
  async renewCleaning(userId: string, subId: string, payload: RenewPayload) {
    this.assertPayload(payload);

    const sub = await this.fetchCleaning(subId);
    this.assertOwnership(sub.user_id, userId);
    if (String(sub.subscription_status).toLowerCase() === "cancelled") {
      throw new ForbiddenException("Cancelled subscriptions cannot be renewed.");
    }

    await this.renewals.verifyPayment({
      method: payload.payment_method,
      reference: payload.payment_reference,
      amountCents: payload.amount_cents,
    });

    const months = Math.max(Number(sub.billing_period_months) || 1, 1);
    const previousEnd = this.endDateOf(sub.end_date, sub.start_date, months);
    const nextStart = this.continuousNextStart(previousEnd);
    const newEnd = this.addMonths(nextStart, months);

    const record = await this.renewals.recordRenewal({
      service: "cleaning",
      subscriptionId: subId,
      previousEnd,
      newStart: nextStart,
      newEnd,
      amountCents: payload.amount_cents,
      surchargeCents: payload.surcharge_cents ?? 0,
      method: payload.payment_method,
      reference: payload.payment_reference,
      idempotencyKey: payload.idempotency_key,
      userId,
    });
    if (record.status === "existing") {
      return {
        ok: true,
        idempotent: true,
        start_date: record.row.new_start,
        end_date: record.row.new_end,
        status: "active" as const,
      };
    }

    await this.patch(`cleaning_subscriptions?id=eq.${this.enc(subId)}`, {
      start_date: nextStart,
      end_date: newEnd,
      subscription_status: "active",
      payment_status: "paid",
      payment_method: payload.payment_method,
      payment_reference: payload.payment_reference,
      periods_paid: (Number(sub.periods_paid) || 1) + 1,
      updated_at: new Date().toISOString(),
    });

    return {
      ok: true,
      idempotent: false,
      start_date: nextStart,
      end_date: newEnd,
      status: "active" as const,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Beach Club
  // ═══════════════════════════════════════════════════════════════════════
  async renewBeach(userId: string, subId: string, payload: RenewPayload) {
    this.assertPayload(payload);

    const sub = await this.fetchBeach(subId);
    this.assertOwnership(sub.user_id, userId);
    if (String(sub.status).toLowerCase() === "cancelled") {
      throw new ForbiddenException("Cancelled subscriptions cannot be renewed.");
    }

    await this.renewals.verifyPayment({
      method: payload.payment_method,
      reference: payload.payment_reference,
      amountCents: payload.amount_cents,
    });

    // Preserve original period length. Beach subs don't carry a
    // billing_period_months column — derive from (end - start) with a 1-month
    // fallback so a poorly-set legacy row still renews sensibly.
    const previousEnd = this.beachEndDateOf(sub);
    const originalDurationDays = this.originalDurationDays(sub.start_date, previousEnd);
    const nextStart = this.continuousNextStart(previousEnd);
    const newEnd = this.addDays(nextStart, originalDurationDays);

    const record = await this.renewals.recordRenewal({
      service: "beach",
      subscriptionId: subId,
      previousEnd,
      newStart: nextStart,
      newEnd,
      amountCents: payload.amount_cents,
      surchargeCents: payload.surcharge_cents ?? 0,
      method: payload.payment_method,
      reference: payload.payment_reference,
      idempotencyKey: payload.idempotency_key,
      userId,
    });
    if (record.status === "existing") {
      return {
        ok: true,
        idempotent: true,
        start_date: record.row.new_start,
        end_date: record.row.new_end,
        status: "active" as const,
      };
    }

    await this.patch(`beach_club_subscriptions?id=eq.${this.enc(subId)}`, {
      start_date: nextStart,
      end_date: newEnd,
      status: "active",
      payment_status: "paid",
      payment_method: payload.payment_method,
      payment_reference: payload.payment_reference,
      updated_at: new Date().toISOString(),
    });

    return {
      ok: true,
      idempotent: false,
      start_date: nextStart,
      end_date: newEnd,
      status: "active" as const,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Universal plans (provider_subscriptions)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * The fourth service, and the one that had no renewal at all: a provider with
   * no legacy table kept its customers here, and "Renew" on that card opened a
   * checkout that bought a SECOND subscription. Same three rules as the rest —
   * verified payment, idempotent retry, one row extended in place.
   */
  async renewPlan(
    user: { id: string; email?: string },
    subId: string,
    payload: RenewPayload,
  ) {
    this.assertPayload(payload);

    const sub = await this.fetchPlan(subId);
    // `provider_subscriptions.user_id` is a uuid, and a Google login's token id
    // is not one — the row was written with the canonical users.id resolved by
    // email, so that is what ownership has to be checked against.
    await this.assertPlanOwnership(sub.user_id, user);
    if (String(sub.status).toLowerCase() === "cancelled") {
      throw new ForbiddenException("Cancelled subscriptions cannot be renewed.");
    }

    await this.renewals.verifyPayment({
      method: payload.payment_method,
      reference: payload.payment_reference,
      amountCents: payload.amount_cents,
    });

    // The term is what was bought: `periods_paid` periods of the plan's own
    // unit, which the purchase snapshotted into metadata. A renewal buys the
    // same term again — never a different one, because the price was quoted
    // for that term.
    const periods = Math.max(1, Number(sub.periods_paid) || 1);
    const unit = String(sub.metadata?.period ?? "monthly").toLowerCase();
    const previousEnd = this.planEndDateOf(sub, unit, periods);
    const nextStart = this.continuousNextStart(previousEnd);
    const newEnd = this.advance(nextStart, unit, periods);

    const record = await this.renewals.recordRenewal({
      service: "plan",
      subscriptionId: subId,
      previousEnd,
      newStart: nextStart,
      newEnd,
      amountCents: payload.amount_cents,
      surchargeCents: payload.surcharge_cents ?? 0,
      method: payload.payment_method,
      reference: payload.payment_reference,
      idempotencyKey: payload.idempotency_key,
      userId: user.id,
    });
    if (record.status === "existing") {
      return {
        ok: true,
        idempotent: true,
        start_date: record.row.new_start,
        end_date: record.row.new_end,
        status: "active" as const,
      };
    }

    await this.patch(`provider_subscriptions?id=eq.${this.enc(subId)}`, {
      start_date: nextStart,
      end_date: newEnd,
      status: "active",
      payment_status: "paid",
      payment_method: payload.payment_method,
      payment_reference: payload.payment_reference,
      updated_at: new Date().toISOString(),
    });

    return {
      ok: true,
      idempotent: false,
      start_date: nextStart,
      end_date: newEnd,
      status: "active" as const,
    };
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  private assertPayload(p: RenewPayload) {
    if (!p?.idempotency_key) throw new BadRequestException("idempotency_key is required");
    if (typeof p.amount_cents !== "number" || p.amount_cents < 0) {
      throw new BadRequestException("amount_cents must be a non-negative integer");
    }
    if (!p.payment_reference?.trim()) throw new BadRequestException("payment_reference is required");
    if (!p.payment_method) throw new BadRequestException("payment_method is required");
  }

  private assertOwnership(subUserId: string | null, userId: string) {
    if (subUserId && String(subUserId) !== String(userId)) {
      throw new ForbiddenException("You do not have access to this subscription");
    }
  }

  /**
   * Same check, one lookup deeper. The legacy tables hold whatever id the token
   * carried; this one holds the canonical uuid, so a Google account's token id
   * never matches it directly and a straight comparison would lock the owner
   * out of their own renewal.
   */
  private async assertPlanOwnership(
    subUserId: string | null,
    user: { id: string; email?: string },
  ) {
    if (!subUserId) return;
    if (String(subUserId) === String(user.id)) return;
    if (user.email) {
      const rows = await this.rest<{ id: string }[]>(
        `users?email=eq.${this.enc(user.email)}&select=id&limit=1`,
      );
      if (rows?.[0]?.id && String(rows[0].id) === String(subUserId)) return;
    }
    throw new ForbiddenException("You do not have access to this subscription");
  }

  // ── Data access (PostgREST) ───────────────────────────────────────────────

  private async fetchCleaning(id: string): Promise<CleaningSubRow> {
    const rows = await this.rest<CleaningSubRow[]>(
      `cleaning_subscriptions?id=eq.${this.enc(id)}&select=id,user_id,subscription_status,start_date,end_date,billing_period_months,monthly_price_cents,total_price_cents,package_id,periods_paid&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Cleaning subscription not found");
    return sub;
  }

  private async fetchPlan(id: string): Promise<PlanSubRow> {
    const rows = await this.rest<PlanSubRow[]>(
      `provider_subscriptions?id=eq.${this.enc(id)}&select=id,user_id,status,start_date,end_date,price_cents,plan_id,periods_paid,metadata&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found");
    return sub;
  }

  private async fetchBeach(id: string): Promise<BeachSubRow> {
    const rows = await this.rest<BeachSubRow[]>(
      `beach_club_subscriptions?id=eq.${this.enc(id)}&select=id,user_id,status,start_date,end_date,total_cents,plan_id,plan_name&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Beach Club subscription not found");
    return sub;
  }

  // ── Date helpers (Honduras local, date-only) ──────────────────────────────

  private today(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  }
  private enc(v: string) { return encodeURIComponent(v); }
  private toDateStr(v: string | null | undefined) { return v ? String(v).slice(0, 10) : null; }
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  private addMonths(dateStr: string, months: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }
  private dayDiff(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  }
  private continuousNextStart(previousEnd: string): string {
    const today = this.today();
    const prevEndPlus1 = this.addDays(previousEnd, 1);
    return this.dayDiff(today, prevEndPlus1) > 0 ? prevEndPlus1 : today;
  }
  private endDateOf(endDate: string | null, startDate: string | null, months: number): string {
    const stored = this.toDateStr(endDate);
    if (stored) return stored;
    const start = this.toDateStr(startDate) || this.today();
    return this.addMonths(start, months);
  }
  private beachEndDateOf(sub: BeachSubRow): string {
    const stored = this.toDateStr(sub.end_date);
    if (stored) return stored;
    const start = this.toDateStr(sub.start_date) || this.today();
    return this.addMonths(start, 1);
  }
  /** One term of a universal plan, in the plan's own unit. */
  private advance(dateStr: string, unit: string, periods: number): string {
    const n = Math.max(1, periods);
    switch (unit) {
      case "weekly":    return this.addDays(dateStr, 7 * n);
      case "quarterly": return this.addMonths(dateStr, 3 * n);
      case "yearly":    return this.addMonths(dateStr, 12 * n);
      default:          return this.addMonths(dateStr, n);
    }
  }
  private planEndDateOf(sub: PlanSubRow, unit: string, periods: number): string {
    const stored = this.toDateStr(sub.end_date);
    if (stored) return stored;
    const start = this.toDateStr(sub.start_date) || this.today();
    return this.advance(start, unit, periods);
  }
  private originalDurationDays(start: string | null, end: string): number {
    const s = this.toDateStr(start);
    if (!s) return 30; // fallback: 1 month
    return Math.max(this.dayDiff(s, end), 1);
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private restBase(): { base: string; key: string } | null {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
      this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    return { base, key };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) return null;
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  private async patch(path: string, body: Record<string, unknown>): Promise<void> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase not configured");
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Subscription update failed (${res.status}): ${text}`);
    }
  }
}
