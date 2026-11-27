import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BlinkService } from "./blink.service";
import { CryptoGatewayService } from "./crypto-gateway/crypto-gateway.service";
import { renewalIdempotencyKey } from "./crypto-gateway/crypto-renewals";
import { PayPalService } from "./paypal.service";
import { PaymentSettlementService } from "./payment-settlement.service";

/** `plan` is a universal `provider_subscriptions` row — a provider with no
 *  legacy table of its own. It renews by the same three rules as the rest. */
export type RenewalService = "food" | "cleaning" | "beach" | "plan";
export type RenewalPaymentMethod = "lightning" | "onchain" | "paypal" | "crypto_gateway";

/** USD cents PayPal captured on an order (all completed captures). */
export function paypalCapturedCents(order: any): number {
  const caps = (order?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []);
  return caps
    .filter((c: any) => String(c?.status).toUpperCase() === "COMPLETED")
    .reduce((s: number, c: any) => s + Math.round(Number(c?.amount?.value ?? 0) * 100), 0);
}

/** What the renewal endpoints accept — one list for every DTO. */
export const RENEWAL_PAYMENT_METHODS: RenewalPaymentMethod[] = ["lightning", "onchain", "paypal", "crypto_gateway"];

/**
 * Tables whose paid rows carry the payment that bought them. A reference found
 * on one of these already paid for that order and cannot also pay a renewal —
 * otherwise the first purchase's payment id would renew the plan for free.
 */
const ORDER_TABLES = ["provider_subscriptions", "food_subscriptions", "cleaning_subscriptions", "rental_bookings"];

interface VerifyInput {
  method: RenewalPaymentMethod;
  reference: string;
  amountCents: number;
}

interface RecordInput {
  service: RenewalService;
  subscriptionId: string;
  previousEnd: string | null;
  newStart: string;
  newEnd: string;
  amountCents: number;
  /**
   * Payment-method processing fee charged on top of amountCents. The customer
   * paid amountCents + surchargeCents; amountCents alone is the service price.
   * Kept separate so provider revenue and processing cost don't get mixed.
   */
  surchargeCents?: number;
  method: string;
  reference: string | null;
  idempotencyKey: string;
  userId: string;
}

interface RecordResult {
  status: "created" | "existing";
  row: {
    id: string;
    previous_end: string | null;
    new_start: string;
    new_end: string;
    amount_cents: number;
    payment_method: string;
    payment_reference: string | null;
    created_at: string;
  };
}

/**
 * Shared renewal engine used by every service (food / cleaning / beach).
 * Enforces:
 *   1. Payment reference is REAL — verified with the actual provider before the
 *      subscription's period is extended (closes the "extend for free" bypass).
 *   2. Idempotency — client can retry safely; a duplicate (subscription_id,
 *      idempotency_key) is a no-op that returns the original outcome.
 *   3. Auditability — every extension is logged in `subscription_renewals` with
 *      the payment reference and the exact period bounds.
 */
@Injectable()
export class SubscriptionRenewalService {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

  constructor(
    private readonly blink: BlinkService,
    private readonly paypal: PayPalService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoGatewayService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  /**
   * What renewing this subscription costs today, by the server's own numbers:
   * the plan's current price x the term that was bought x people (only where
   * the plan is priced per person) - the same formula the checkout shows
   * (frontend lib/checkout/planCheckoutModel.totalFor). Null when the plan
   * cannot be found; the caller then falls back to the row's stored price.
   *
   * Pass `planId` (a provider_plans id) or `sourceKey` + `sourcePlanId` (the
   * legacy food / cleaning plan the catalog row mirrors).
   */
  async renewalPriceCents(q: {
    planId?: string | null;
    sourceKey?: string;
    sourcePlanId?: string | null;
    periods: number;
    people?: number;
  }): Promise<number | null> {
    const enc = encodeURIComponent;
    let filter: string | null = null;
    if (q.planId) filter = `id=eq.${enc(q.planId)}`;
    else if (q.sourceKey && q.sourcePlanId) filter = `source_service_key=eq.${enc(q.sourceKey)}&source_plan_id=eq.${enc(q.sourcePlanId)}`;
    if (!filter) return null;
    const rows = await this.rest<Array<{ price_cents: number | null; pricing_mode: string | null }>>(
      `/provider_plans?${filter}&select=price_cents,pricing_mode&order=created_at.asc&limit=1`,
      { method: "GET" },
    ).catch(() => [] as Array<{ price_cents: number | null; pricing_mode: string | null }>);
    const plan = rows?.[0];
    if (!plan || plan.price_cents == null) return null;
    const perPerson = plan.pricing_mode === "per_person";
    return Number(plan.price_cents) * Math.max(1, Number(q.periods) || 1) * (perPerson ? Math.max(1, Number(q.people) || 1) : 1);
  }

  /**
   * The amount a renewal claims must be the renewal's price. Before this the
   * browser's `amount_cents` was trusted outright, so a 1-cent payment
   * claiming "amount_cents: 1" extended any plan. A cent of rounding is not a
   * shortfall. With no price to check against (plan gone, nothing stored) the
   * renewal is refused rather than waved through.
   */
  assertCoversPrice(amountCents: number, expectedCents: number | null): void {
    if (expectedCents == null || !Number.isFinite(expectedCents) || expectedCents <= 0) {
      throw new ForbiddenException("This subscription's price could not be determined. Contact support to renew it.");
    }
    if (!Number.isFinite(amountCents) || amountCents + 1 < expectedCents) {
      throw new ForbiddenException(`Renewal amount is below the plan price (USD ${(expectedCents / 100).toFixed(2)}).`);
    }
  }

  /**
   * Verify a payment reference against its issuing provider. Throws
   * ForbiddenException if the payment is not confirmed paid.
   */
  async verifyPayment({ method, reference, amountCents }: VerifyInput): Promise<{ providerStatus: string }> {
    if (!reference || !reference.trim()) {
      throw new BadRequestException("payment_reference is required");
    }
    const m = String(method).toLowerCase() as RenewalPaymentMethod;

    if (m === "lightning") {
      const r = await this.blink.getPaymentStatus(reference);
      if (!r.paid) throw new ForbiddenException(`Lightning payment not confirmed (status ${r.status})`);
      // Paid is not enough: the invoice must be one this server raised, for at
      // least this renewal's amount (its checkout session says what it was for).
      const session = await this.settlement.sessionFor("blink", reference);
      if (!session) throw new ForbiddenException("Lightning invoice was not raised by this server.");
      if ((session.amount_cents ?? 0) + 1 < amountCents) throw new ForbiddenException("Lightning payment is below the renewal amount.");
      return { providerStatus: r.status };
    }

    if (m === "onchain") {
      // On-chain requires (address, amount_sats) to check the mempool. The
      // reference we accept here is the address; sats derives from amountCents
      // at the BTC price we can't fetch from a NestJS-owned oracle reliably.
      // Punt: mark onchain unsupported for renewal via API — customers use the
      // fresh checkout flow which persists the confirmation on the sub itself.
      throw new ForbiddenException("On-chain BTC renewals must go through checkout, not the renewal endpoint.");
    }

    if (m === "paypal") {
      // PayPal orders can already be captured (COMPLETED) or in APPROVED state
      // waiting for capture. captureOrder is idempotent — re-captures resolve as
      // paid instead of erroring, so we can just call it here.
      let status = "COMPLETED";
      try {
        const r = await this.paypal.captureOrder(reference);
        if (!r.paid) throw new ForbiddenException("PayPal order not COMPLETED");
        status = r.status;
      } catch {
        // Fall back to reading the order — it may have been captured already
        // via a webhook we don't own.
        const order = (await this.paypal.getOrder(reference)) as any;
        if (order?.status !== "COMPLETED") throw new ForbiddenException("PayPal payment not confirmed");
      }
      // What PayPal actually captured must cover this renewal.
      const order = (await this.paypal.getOrder(reference).catch(() => null)) as any;
      if (paypalCapturedCents(order) + 1 < amountCents) throw new ForbiddenException("PayPal payment is below the renewal amount.");
      return { providerStatus: status };
    }

    if (m === "crypto_gateway") {
      // USDT/USDC/ETH/… through NOWPayments. paidFor() insists the payment was
      // raised by this server (a checkout session exists), the gateway says it
      // is paid, and the gateway's price covers this renewal.
      const r = await this.crypto.paidFor(reference, amountCents);
      if (!r.ok) throw new ForbiddenException(`Crypto payment not accepted (${r.reason})`);
      return { providerStatus: r.status };
    }

    throw new BadRequestException(`Unsupported payment_method: ${method}`);
  }

  /**
   * One payment renews one period, once. Rejects a reference that already
   * renewed something else (another subscription, or this one under another
   * idempotency key) or that paid for an order. A retry of the SAME renewal
   * (same subscription + key) passes, so idempotent retries keep working.
   */
  async assertReferenceUnused(input: { subscriptionId: string; idempotencyKey: string; reference: string | null }): Promise<void> {
    const ref = (input.reference || "").trim();
    if (!ref) return;
    const enc = encodeURIComponent;
    const prior = await this.rest<Array<{ subscription_id: string; idempotency_key: string }>>(
      `/subscription_renewals?payment_reference=eq.${enc(ref)}&select=subscription_id,idempotency_key&limit=5`,
      { method: "GET" },
    );
    if (prior.some((r) => r.subscription_id === input.subscriptionId && r.idempotency_key === input.idempotencyKey)) return;
    if (prior.length) throw new ForbiddenException("This payment has already been used for a renewal.");
    for (const table of ORDER_TABLES) {
      const rows = await this.rest<Array<{ id: string }>>(
        `/${table}?payment_reference=eq.${enc(ref)}&payment_status=eq.paid&select=id&limit=1`,
        { method: "GET" },
      );
      if (rows.length) throw new ForbiddenException("This payment already paid for an order.");
    }
  }

  /**
   * Insert the renewal audit row. On idempotency collision, returns the
   * pre-existing row so the caller can respond deterministically to retries.
   *
   * Uses PostgREST's `resolution=ignore-duplicates` header: on the unique index
   * (subscription_id, idempotency_key), the second-and-onward calls skip the
   * INSERT and we then SELECT the surviving row.
   */
  async recordRenewal(raw: RecordInput): Promise<RecordResult> {
    // A gateway payment renews under ONE key, whoever records it first — the
    // customer's browser or the gateway's webhook — so the second caller gets
    // the first one's outcome rather than "payment already used".
    const input: RecordInput =
      raw.method === "crypto_gateway" && raw.reference
        ? { ...raw, idempotencyKey: renewalIdempotencyKey(raw.reference) }
        : raw;
    await this.assertReferenceUnused(input);
    const body = {
      service: input.service,
      subscription_id: input.subscriptionId,
      previous_end: input.previousEnd,
      new_start: input.newStart,
      new_end: input.newEnd,
      amount_cents: input.amountCents,
      surcharge_cents: input.surchargeCents ?? 0,
      payment_method: input.method,
      payment_reference: input.reference,
      idempotency_key: input.idempotencyKey,
      // Empty when the gateway webhook renews a row with no owner on file.
      renewed_by_user: input.userId || null,
    };

    // First attempt — ignore-duplicates returns [] on conflict instead of 409.
    const inserted = await this.rest<any[]>(
      "/subscription_renewals?on_conflict=subscription_id,idempotency_key",
      {
        method: "POST",
        headers: {
          Prefer: "resolution=ignore-duplicates, return=representation",
        },
        body: JSON.stringify(body),
      },
    );

    if (Array.isArray(inserted) && inserted.length) {
      // Fire-and-forget user notification. Non-blocking — the renewal already
      // succeeded; a failed notification shouldn't roll it back.
      if (input.userId) this.notifyUser(input, inserted[0]).catch((err) => {
        this.logger.warn(`[renewal-notify] user ${input.userId}: ${err.message}`);
      });
      return { status: "created", row: inserted[0] };
    }

    // Conflict path — fetch the winner. Two rows can't exist under the unique
    // index so this is deterministic.
    const enc = encodeURIComponent;
    const existing = await this.rest<any[]>(
      `/subscription_renewals?subscription_id=eq.${enc(input.subscriptionId)}&idempotency_key=eq.${enc(input.idempotencyKey)}&select=*&limit=1`,
      { method: "GET" },
    );
    const row = existing?.[0];
    if (!row) {
      throw new Error("Renewal insert returned empty and no existing row found — Supabase state inconsistency.");
    }
    return { status: "existing", row };
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  // Insert into user_notifications directly via REST — avoids a cross-module
  // dependency on AccountNotificationsService (which sits in AccountModule and
  // would create a circular import).

  private async notifyUser(input: RecordInput, row: RecordResult["row"]): Promise<void> {
    const SERVICE_LABEL: Record<RenewalService, string> = {
      food: "Meal plan",
      cleaning: "Cleaning plan",
      beach: "Beach Club membership",
      plan: "Subscription",
    };
    const label = SERVICE_LABEL[input.service] ?? "Subscription";
    // What the customer actually paid, not just the service price — quoting the
    // base here made the renewal notification disagree with their statement.
    const dollars = ((row.amount_cents + (input.surchargeCents ?? 0)) / 100).toFixed(2);
    const actionUrl =
      input.service === "food"
        ? `/services/food/subscription/${input.subscriptionId}`
        : input.service === "cleaning"
        ? "/my-subscriptions?tab=cleaning"
        : input.service === "beach"
        ? "/my-subscriptions?tab=beach"
        : "/my-subscriptions";

    await this.rest("/user_notifications", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        recipient_user_id: input.userId,
        category: "subscription",
        // Reusing subscription_created here — the notifications page already
        // knows how to render it. If we later add a dedicated "renewed" type
        // it's a data-only migration.
        type: "subscription_created",
        title: `${label} renewed`,
        body: `Extended through ${row.new_end}. Charged $${dollars} via ${row.payment_method}.`,
        related_entity_type: `${input.service}_subscription`,
        related_entity_id: input.subscriptionId,
        action_url: actionUrl,
        metadata: {
          renewal_id: row.id,
          previous_end: row.previous_end,
          new_start: row.new_start,
          new_end: row.new_end,
          payment_reference: row.payment_reference,
        },
      }),
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async rest<T>(path: string, init: RequestInit): Promise<T> {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
      this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) throw new Error("Supabase REST not configured");
    const res = await fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase REST ${res.status}: ${text}`);
    }
    // 204 has no body — return an empty object cast.
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }
}
