import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import type {
  CleaningSubscriptionDto,
  FoodSubscriptionDto,
  ProvisionSubscriptionDto,
  ProvisionSubscriptionResponse,
} from "./dto/provision-subscription.dto";

/**
 * Builders Node → ProsperaSub subscription mirror.
 *
 * Public entry: `provisionSubscription()` — upserts the customer by email and
 * creates the food/cleaning subscription rows they asked for. Both legs are
 * created as `status=active`, `payment_status=paid`, `payment_method=manual`
 * so they surface to providers as live-revenue rows immediately (Builders
 * Node collected payment on their side; we're just mirroring the grant).
 *
 * Idempotent by `external_ref`: if a request with the same ref lands twice,
 * the second call returns the same subscription IDs instead of creating
 * duplicates. Implementation uses `payment_reference = "builders-node:<ref>"`
 * as the lookup key so no schema change was needed on our end.
 *
 * Never partially rolls back — the user upsert always sticks, and each leg
 * (food, cleaning) independently succeeds or emits a `warning` in the
 * response. Callers use the returned IDs + warnings to decide what to retry.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly config: ConfigService) {}

  async provisionSubscription(body: ProvisionSubscriptionDto): Promise<ProvisionSubscriptionResponse> {
    if (!body.food && !body.cleaning) {
      throw new BadRequestException("Provide at least one of `food` or `cleaning`");
    }

    const rest = this.restBase();
    if (!rest) {
      throw new ServiceUnavailableException("Supabase is not configured on the server");
    }

    const warnings: string[] = [];

    // ── 1. Customer (upsert by email) ───────────────────────────────────────
    const userId = await this.upsertUserByEmail(body.customer.email, body.customer.name);

    // ── 2. Food subscription (optional) ─────────────────────────────────────
    let foodSubscriptionId: string | null = null;
    if (body.food) {
      try {
        foodSubscriptionId = await this.provisionFoodSubscription(
          userId, body.customer, body.food, body.external_ref,
        );
      } catch (e) {
        const msg = (e as Error).message || "unknown error";
        this.logger.warn(`[integrations] food leg failed: ${msg}`);
        warnings.push(`food: ${msg}`);
      }
    }

    // ── 3. Cleaning subscription (optional) ─────────────────────────────────
    let cleaningSubscriptionId: string | null = null;
    if (body.cleaning) {
      try {
        cleaningSubscriptionId = await this.provisionCleaningSubscription(
          userId, body.customer, body.cleaning, body.external_ref,
        );
      } catch (e) {
        const msg = (e as Error).message || "unknown error";
        this.logger.warn(`[integrations] cleaning leg failed: ${msg}`);
        warnings.push(`cleaning: ${msg}`);
      }
    }

    return {
      user_id: userId,
      food_subscription_id: foodSubscriptionId,
      cleaning_subscription_id: cleaningSubscriptionId,
      warnings,
    };
  }

  // ─── User upsert ───────────────────────────────────────────────────────────

  private async upsertUserByEmail(email: string, name: string | undefined): Promise<string> {
    const normalized = email.trim().toLowerCase();

    const existing = await this.rest<Array<{ id: string }>>(
      `users?select=id&email=eq.${encodeURIComponent(normalized)}&limit=1`,
    );
    if (existing && existing[0]?.id) return existing[0].id;

    // Not found → create via the same signup RPC the app uses. The password is
    // a random placeholder; Builders Node users don't log in here with a
    // password (they'll use Google OAuth or password-reset if they ever do).
    const password = randomBytes(24).toString("base64url");
    try {
      const rpc = await this.rpc<{ id: string } | null>("auth_signup_user", {
        p_email: normalized,
        p_name: (name || "").trim(),
        p_password: password,
      });
      if (rpc?.id) return rpc.id;
    } catch (e) {
      // If the RPC reports the row already exists (race between check + insert),
      // read it back and use that id. Any other error propagates.
      const msg = (e as Error).message || "";
      if (msg.toLowerCase().includes("conflict") || msg.toLowerCase().includes("already exists")) {
        const again = await this.rest<Array<{ id: string }>>(
          `users?select=id&email=eq.${encodeURIComponent(normalized)}&limit=1`,
        );
        if (again && again[0]?.id) return again[0].id;
      }
      throw new BadRequestException(`Could not create user for ${normalized}: ${msg}`);
    }
    throw new BadRequestException(`Could not resolve user for ${normalized}`);
  }

  // ─── Food subscription ─────────────────────────────────────────────────────

  private async provisionFoodSubscription(
    userId: string,
    customer: ProvisionSubscriptionDto["customer"],
    plan: FoodSubscriptionDto,
    externalRef: string | undefined,
  ): Promise<string> {
    // Idempotency: same external_ref + same meal plan for the same user means
    // "already provisioned" — return the existing id rather than duplicating.
    const paymentRef = externalRef ? `builders-node:${externalRef}` : null;
    if (paymentRef) {
      const existing = await this.rest<Array<{ id: string }>>(
        `food_subscriptions?select=id&user_id=eq.${userId}&meal_plan_id=eq.${plan.meal_plan_id}` +
          `&payment_reference=eq.${encodeURIComponent(paymentRef)}&limit=1`,
      );
      if (existing && existing[0]?.id) return existing[0].id;
    }

    // Validate the plan exists + belongs to a real provider before we insert —
    // Postgres would reject a bad meal_plan_id with a foreign-key error that's
    // harder to explain than "meal plan not found".
    const plans = await this.rest<Array<{ id: string; provider_id: string; weekly_price_cents: number }>>(
      `food_meal_plans?select=id,provider_id,weekly_price_cents&id=eq.${plan.meal_plan_id}&limit=1`,
    );
    const planRow = plans?.[0];
    if (!planRow) throw new Error(`meal_plan_id ${plan.meal_plan_id} not found`);

    const startedAt = plan.started_at || this.todayHN();
    const endDate = this.addDaysISO(startedAt, Math.max(plan.weeks, 1) * 7 - 1);
    const payload: Record<string, unknown> = {
      user_id: userId,
      provider_id: planRow.provider_id,
      meal_plan_id: plan.meal_plan_id,
      weekly_price_cents: planRow.weekly_price_cents,
      commitment_weeks: plan.weeks,
      started_at: startedAt,
      end_date: endDate,
      status: "active",
      payment_status: "paid",
      payment_method: "manual",
      periods_paid: 1,
      customer_name: (customer.name || "").trim() || null,
      customer_whatsapp: (customer.whatsapp || "").trim() || null,
      residence: plan.residence?.trim() || null,
      delivery_address: plan.delivery_address?.trim() || null,
      notes: plan.notes?.trim() || "Provisioned by Builders Node",
      payment_reference: paymentRef,
    };

    const rows = await this.insertReturning<{ id: string }>("food_subscriptions", payload);
    if (!rows[0]?.id) throw new Error("food_subscriptions insert returned no id");
    return rows[0].id;
  }

  // ─── Cleaning subscription ─────────────────────────────────────────────────

  private async provisionCleaningSubscription(
    userId: string,
    _customer: ProvisionSubscriptionDto["customer"],
    plan: CleaningSubscriptionDto,
    externalRef: string | undefined,
  ): Promise<string> {
    const paymentRef = externalRef ? `builders-node:${externalRef}` : null;
    if (paymentRef) {
      const existing = await this.rest<Array<{ id: string }>>(
        `cleaning_subscriptions?select=id&user_id=eq.${userId}&package_id=eq.${plan.package_id}` +
          `&payment_reference=eq.${encodeURIComponent(paymentRef)}&limit=1`,
      );
      if (existing && existing[0]?.id) return existing[0].id;
    }

    // Look up the package for its monthly price + monthly cleaning count so we
    // can precompute the same fields the public checkout writes.
    const pkgs = await this.rest<Array<{
      id: string; monthly_price_cents: number; cleanings_per_month: number;
    }>>(
      `cleaning_packages?select=id,monthly_price_cents,cleanings_per_month&id=eq.${plan.package_id}&limit=1`,
    );
    const pkg = pkgs?.[0];
    if (!pkg) throw new Error(`package_id ${plan.package_id} not found`);

    const startedAt = plan.started_at || this.todayHN();
    const endDate = this.addMonthsISO(startedAt, plan.months);
    const monthlyCents = Number(pkg.monthly_price_cents) || 0;
    const totalCents = monthlyCents * plan.months;
    const cleaningsIncluded = (Number(pkg.cleanings_per_month) || 0) * plan.months;

    const payload: Record<string, unknown> = {
      user_id: userId,
      package_id: plan.package_id,
      start_date: startedAt,
      end_date: endDate,
      service_start_date: startedAt,
      service_end_date: endDate,
      paid_until: endDate,
      billing_period_months: plan.months,
      monthly_price_cents: monthlyCents,
      total_price_cents: totalCents,
      cleanings_remaining: cleaningsIncluded,
      payment_status: "paid",
      payment_method: "manual",
      payment_reference: paymentRef,
      // Sub goes straight to pending_schedule + active so it shows up on the
      // provider's Bookings tab. The customer still has to pick their weekly
      // slot via /my-subscriptions before any cleanings actually get booked.
      subscription_status: "pending_schedule",
      is_active: true,
      apartment_note: plan.apartment_note?.trim() || null,
      cleaner_hint: plan.cleaner_hint?.trim() || null,
      admin_notes: "Provisioned by Builders Node",
    };

    const rows = await this.insertReturning<{ id: string }>("cleaning_subscriptions", payload);
    if (!rows[0]?.id) throw new Error("cleaning_subscriptions insert returned no id");
    return rows[0].id;
  }

  // ─── PostgREST + RPC helpers ───────────────────────────────────────────────

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
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    if (!res.ok) {
      this.logger.warn(`[integrations.rest] ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  }

  private async insertReturning<T>(table: string, body: Record<string, unknown>): Promise<T[]> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
    const res = await fetch(`${cfg.base}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${table} insert failed (${res.status}): ${text || "no body"}`);
    }
    return (await res.json()) as T[];
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase is not configured");
    const res = await fetch(`${cfg.base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RPC ${name} failed (${res.status}): ${text || "no body"}`);
    }
    return (await res.json()) as T;
  }

  // ─── Time helpers (Honduras local) ─────────────────────────────────────────

  private todayHN(): string {
    // Honduras is UTC-6 year-round (no DST) — shift UTC by six hours to land
    // on today HN, then slice to YYYY-MM-DD.
    const now = new Date(Date.now() - 6 * 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
  }

  private addDaysISO(isoDate: string, days: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private addMonthsISO(isoDate: string, months: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }
}
