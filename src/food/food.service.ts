import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  RenewalPaymentMethod,
  SubscriptionRenewalService,
} from "../payments/subscription-renewal.service";

const TZ = "America/Tegucigalpa";
const DAY_MS = 86_400_000;

export type FoodEffectiveStatus =
  | "active"
  | "expiring_soon"
  | "expired"
  | "paused"
  | "cancelled"
  | "pending";

interface FoodSubRow {
  id: string;
  user_id: string | null;
  provider_id: string | null;
  meal_plan_id: string | null;
  status: string | null;
  started_at: string | null;
  end_date: string | null;
  commitment_weeks: number | null;
  weekly_price_cents: number | null;
  delivery_address: string | null;
  customer_whatsapp: string | null;
  customer_name: string | null;
  notes: string | null;
  created_at: string | null;
  periods_paid: number | null;
}

@Injectable()
export class FoodService {
  private readonly logger = new Logger(FoodService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly renewals: SubscriptionRenewalService,
  ) {}

  // ─── Date helpers (date-only, Honduras local) ────────────────────────────────

  /** Today's date in Honduras as YYYY-MM-DD. */
  private today(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  }

  private toDateStr(value: string | null | undefined): string | null {
    if (!value) return null;
    return String(value).slice(0, 10);
  }

  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Whole-day difference toStr - fromStr (positive => toStr is later). */
  private dayDiff(fromStr: string, toStr: string): number {
    return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / DAY_MS);
  }

  private weeksOf(sub: FoodSubRow): number {
    return Math.max(Number(sub.commitment_weeks ?? 1) || 1, 1);
  }

  /**
   * Authoritative period end: stored end_date, else derived from started_at.
   *
   * Inclusive semantics: "1 week" = 7 days of access counting the start_date.
   * Formula: end = start + (weeks*7) - 1. So buying Mon for 1 week gives access
   * Mon–Sun; the next Monday is expired. This matches user expectation of "7
   * days" and gives the renewal a clean handoff (next_start = end + 1).
   */
  private endDateOf(sub: FoodSubRow): string {
    const stored = this.toDateStr(sub.end_date);
    if (stored) return stored;
    const start = this.toDateStr(sub.started_at) || this.toDateStr(sub.created_at) || this.today();
    return this.addDays(start, this.weeksOf(sub) * 7 - 1);
  }

  /**
   * Compute the lifecycle state of a subscription. The expiry decision is made
   * here on the server — the client never decides access.
   */
  computeLifecycle(sub: FoodSubRow) {
    const today = this.today();
    const endDate = this.endDateOf(sub);
    const daysLeft = this.dayDiff(today, endDate); // >= 0 while today <= endDate
    const raw = String(sub.status ?? "active").toLowerCase();

    let status: FoodEffectiveStatus;
    let access: boolean;
    let canRenew = false;

    if (raw === "cancelled") {
      status = "cancelled";
      access = false;
    } else if (raw === "paused") {
      status = "paused";
      access = false;
    } else if (raw === "pending") {
      status = "pending";
      access = false;
    } else if (daysLeft < 0) {
      // current_date > end_date  →  expired
      status = "expired";
      access = false;
      canRenew = true;
    } else if (daysLeft <= 2) {
      // within 2 days of expiry — still has access, can renew early
      status = "expiring_soon";
      access = true;
      canRenew = true;
    } else {
      status = "active";
      access = true;
    }

    return { status, access, canRenew, daysLeft, endDate };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Returns the subscription with a server-computed access decision. The
   * this-week menu content is only included when access is granted.
   */
  async getSubscriptionAccess(userId: string, subId: string) {
    const sub = await this.fetchOwnedSub(userId, subId);
    const life = this.computeLifecycle(sub);

    // Lazily persist a freshly-detected expiry so the admin views stay correct
    // even before the daily sweep runs.
    if (life.status === "expired" && String(sub.status).toLowerCase() === "active") {
      await this.patch(`food_subscriptions?id=eq.${subId}`, { status: "expired", updated_at: new Date().toISOString() });
      sub.status = "expired";
    }

    const [provider, plan] = await Promise.all([
      sub.provider_id ? this.fetchProvider(sub.provider_id) : Promise.resolve(null),
      sub.meal_plan_id ? this.fetchPlan(sub.meal_plan_id) : Promise.resolve(null),
    ]);

    const menu = life.access ? await this.fetchWeeklyMenu(sub) : null;

    return {
      access: life.access,
      status: life.status,
      reason: this.reasonFor(life.status, life.daysLeft),
      daysLeft: life.daysLeft,
      canRenew: life.canRenew,
      subscription: {
        id: sub.id,
        provider_id: sub.provider_id,
        meal_plan_id: sub.meal_plan_id,
        status: sub.status,
        started_at: this.toDateStr(sub.started_at),
        end_date: life.endDate,
        commitment_weeks: this.weeksOf(sub),
        weekly_price_cents: sub.weekly_price_cents ?? 0,
        delivery_address: sub.delivery_address,
        customer_whatsapp: sub.customer_whatsapp,
        notes: sub.notes,
      },
      provider,
      plan,
      menu,
    };
  }

  /**
   * Renew: continuous period with no gap/overlap.
   *   next_start = max(today, previous_end + 1)
   *   end_date   = next_start + plan_duration
   *
   * Now hardened:
   *   - Requires payment_method + payment_reference; verifies with the actual
   *     provider (Blink / SimpleFi / PayPal) so a stolen JWT can't extend a
   *     subscription for free.
   *   - Requires idempotency_key; retries within the same key return the same
   *     result without double-extending or double-billing.
   *   - Emits a `subscription_renewals` audit row for every renewal so we can
   *     answer "who / when / how much / paid with what".
   */
  async renewSubscription(
    userId: string,
    subId: string,
    payload: {
      payment_method: RenewalPaymentMethod;
      payment_reference: string;
      amount_cents: number;
      /** Processing fee charged on top of amount_cents (0 when the method is free). */
      surcharge_cents?: number;
      idempotency_key: string;
    },
  ) {
    const sub = await this.fetchOwnedSub(userId, subId);
    if (String(sub.status).toLowerCase() === "cancelled") {
      throw new ForbiddenException("Cancelled subscriptions cannot be renewed.");
    }

    if (!payload?.idempotency_key) {
      throw new BadRequestException("idempotency_key is required");
    }
    if (!payload?.amount_cents || payload.amount_cents < 0) {
      throw new BadRequestException("amount_cents must be a non-negative integer");
    }

    // 1) Verify the payment before we touch the subscription. Throws 403 on a
    //    reference the provider doesn't confirm as paid.
    await this.renewals.verifyPayment({
      method: payload.payment_method,
      reference: payload.payment_reference,
      amountCents: payload.amount_cents,
    });

    const previousEnd = this.endDateOf(sub);
    const today = this.today();
    const prevEndPlus1 = this.addDays(previousEnd, 1);
    const nextStart = this.dayDiff(today, prevEndPlus1) > 0 ? prevEndPlus1 : today;
    // Inclusive period end (see endDateOf comment): -1 so N weeks = N*7 days.
    const newEnd = this.addDays(nextStart, this.weeksOf(sub) * 7 - 1);

    // 2) Idempotency guard. If this exact idempotency_key already renewed this
    //    subscription, `existing` returns the original audit row and we short-
    //    circuit — no double-extension.
    const record = await this.renewals.recordRenewal({
      service: "food",
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
        started_at: record.row.new_start,
        end_date: record.row.new_end,
        status: "active" as const,
      };
    }

    // 3) Extend the subscription now that the audit trail exists.
    await this.patch(`food_subscriptions?id=eq.${subId}`, {
      started_at: nextStart,
      end_date: newEnd,
      status: "active",
      payment_status: "paid",
      payment_method: payload.payment_method,
      payment_reference: payload.payment_reference,
      periods_paid: (Number(sub.periods_paid) || 1) + 1,
      paused_at: null,
      cancelled_at: null,
      updated_at: new Date().toISOString(),
    });

    return {
      ok: true,
      idempotent: false,
      started_at: nextStart,
      end_date: newEnd,
      status: "active" as const,
    };
  }

  private reasonFor(status: FoodEffectiveStatus, daysLeft: number): string {
    switch (status) {
      case "active":
        return "Subscription active";
      case "expiring_soon":
        return daysLeft === 0 ? "Expires today" : `Expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      case "expired":
        return "Subscription expired — renew to regain access";
      case "paused":
        return "Subscription paused";
      case "pending":
        return "Payment pending";
      case "cancelled":
        return "Subscription cancelled";
    }
  }

  // ─── Data access (PostgREST over HTTPS) ──────────────────────────────────────

  private async fetchOwnedSub(userId: string, subId: string): Promise<FoodSubRow> {
    const rows = await this.rest<FoodSubRow[]>(
      `food_subscriptions?select=*&id=eq.${encodeURIComponent(subId)}&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found");
    if (sub.user_id && sub.user_id !== userId) {
      throw new ForbiddenException("You do not have access to this subscription");
    }
    return sub;
  }

  private async fetchProvider(id: string) {
    const rows = await this.rest<Array<{ id: string; name: string }>>(
      `food_providers?select=id,name&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    return rows?.[0] ?? null;
  }

  private async fetchPlan(id: string) {
    const rows = await this.rest<Array<{ id: string; name: string; meals_per_day: number }>>(
      `food_meal_plans?select=id,name,meals_per_day&id=eq.${encodeURIComponent(id)}&limit=1`,
    );
    return rows?.[0] ?? null;
  }

  private async fetchWeeklyMenu(sub: FoodSubRow) {
    let menu: { id: string; week_start_date: string } | null = null;

    if (sub.meal_plan_id) {
      const rows = await this.rest<Array<{ id: string; week_start_date: string }>>(
        `food_weekly_menus?select=id,week_start_date&meal_plan_id=eq.${encodeURIComponent(sub.meal_plan_id)}&is_published=eq.true&order=week_start_date.desc&limit=1`,
      );
      menu = rows?.[0] ?? null;
    }
    if (!menu && sub.provider_id) {
      const rows = await this.rest<Array<{ id: string; week_start_date: string }>>(
        `food_weekly_menus?select=id,week_start_date&provider_id=eq.${encodeURIComponent(sub.provider_id)}&meal_plan_id=is.null&is_published=eq.true&order=week_start_date.desc&limit=1`,
      );
      menu = rows?.[0] ?? null;
    }
    if (!menu) return null;

    const meals = await this.rest<Array<Record<string, unknown>>>(
      `food_menu_meals?select=*&menu_id=eq.${encodeURIComponent(menu.id)}&order=sort_order.asc`,
    );
    return { week_start_date: menu.week_start_date, meals: meals ?? [] };
  }

  private restBase(): { base: string; key: string } | null {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    return { base, key };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) return null;
    try {
      const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      });
      if (!res.ok) {
        this.logger.warn(`[food.rest] ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.error(`[food.rest] ${path} error: ${(err as Error).message}`);
      return null;
    }
  }

  private async patch(path: string, body: Record<string, unknown>): Promise<void> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
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
      throw new Error(`Food update failed (${res.status}): ${text}`);
    }
  }
}
