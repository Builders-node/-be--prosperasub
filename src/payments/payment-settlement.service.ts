import { Injectable, Logger } from "@nestjs/common";
import { BillingService } from "../billing/billing.service";
import type { PaymentMethod } from "../billing/payment-provider.port";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * Flipping a row to paid once a payment has been VERIFIED — shared by every
 * server-side confirmation path (the Blink webhook, the crypto-gateway webhook).
 *
 * This lived inside the Blink webhook. A second rail that confirms payments
 * server-side would have had to copy it, and the four tables, the per-table
 * "paid" state and the ledger call are exactly the things that drift when
 * copied: rentals were once missing from one copy and a Bitcoin payment only
 * landed if the customer's browser was still open.
 *
 * It does not verify anything itself. The caller must have asked the payment
 * provider first — a webhook body is a hint, never a decision.
 */

export const SETTLEMENT_TABLES = [
  { table: "cleaning_subscriptions", extra: "&deleted_at=is.null" },
  { table: "food_subscriptions",     extra: "" },
  // The beach's memberships are universal rows; the legacy twin follows by
  // trigger, so verifying the old table would confirm a payment against a
  // copy and leave the row this platform now considers the real one pending.
  // A NULL source key is a purchase on a universal-only service — same rails.
  // Rows keyed cleaning/food stay excluded: they are the frozen backfill.
  { table: "provider_subscriptions", extra: "&or=(source_service_key.eq.beach,source_service_key.is.null)" },
  // Car rentals settle on the same rails.
  { table: "rental_bookings",        extra: "&deleted_at=is.null" },
] as const;

export interface SettleOptions {
  /** Billing ledger method (what the payment port calls it). */
  method: PaymentMethod;
  /** Concrete gateway, as written to the ledger (`blink`, `nowpayments`, …). */
  billingProvider: string;
  /** Key the checkout session was written under — finds the client details. */
  sessionProvider: string;
  /** Free-form tag for the ledger row (`viaWebhook`, …). */
  via?: string;
}

@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger("PaymentSettlement");

  constructor(
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Pending rows that carry a reference and were paid by one of `methods`,
   * newest first, at most `limit` per table. Rows without a reference cannot
   * be checked at all — the daily cron expires those.
   */
  async pendingReferences(methods: string[], limit: number): Promise<Array<{ table: string; id: string; ref: string; method: string }>> {
    const out: Array<{ table: string; id: string; ref: string; method: string }> = [];
    const list = methods.map(encodeURIComponent).join(",");
    for (const { table, extra } of SETTLEMENT_TABLES) {
      try {
        const rows = await this.rest<Array<{ id: string; payment_reference: string; payment_method: string }>>(
          `/${table}?select=id,payment_reference,payment_method&payment_status=neq.paid` +
          `&payment_reference=not.is.null&payment_method=in.(${list})${extra}` +
          `&order=created_at.desc&limit=${limit}`,
        );
        for (const r of rows ?? []) {
          out.push({ table, id: String(r.id), ref: String(r.payment_reference), method: String(r.payment_method) });
        }
      } catch {
        continue;
      }
    }
    return out;
  }

  /** Flip every row holding this reference, and record it in the ledger once. */
  async markPaidByReference(ref: string, opts: SettleOptions): Promise<boolean> {
    let touched = false;
    for (const { table, extra } of SETTLEMENT_TABLES) {
      try {
        const rows = await this.rest<Array<{ id: string }>>(
          `/${table}?select=id&payment_reference=eq.${encodeURIComponent(ref)}&payment_status=neq.paid${extra}&limit=5`,
        );
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (const row of rows) {
          await this.rest(
            `/${table}?id=eq.${encodeURIComponent(row.id)}`,
            { method: "PATCH", body: JSON.stringify(paidPatch(table, ref)) },
          );
          touched = true;
          // Idempotent per (provider, ref) — a webhook that arrives twice, or
          // after the cron already saw it, records and emits once.
          await this.billing.recordCaptured({
            method: opts.method,
            provider: opts.billingProvider,
            providerRef: ref,
            subjectRef: `subscription:${row.id}`,
            metadata: { table, ...(opts.via ? { [opts.via]: true } : {}) },
          }).catch((e) => this.logger.warn(`ledger write failed: ${(e as Error).message}`));

          // Tell the team money arrived. notifyPaymentSucceeded is idempotent
          // per (provider, reference), so a webhook that races the cron or
          // arrives twice still notifies once.
          await this.notifications.notifyPaymentSucceededForProviderRef(
            opts.sessionProvider,
            ref,
            { paymentStatus: "paid", paidAt: new Date() },
            { serviceName: table === "rental_bookings" ? "EverySub Cars — rental" : `EverySub — ${table.replace(/_subscriptions$/, "")}` },
          ).catch((e) => this.logger.warn(`admin notify failed: ${(e as Error).message}`));
        }
      } catch (e) {
        this.logger.debug(`scan ${table} failed: ${(e as Error).message}`);
      }
    }
    if (touched) this.logger.log(`confirmed ${opts.method} payment ${ref.slice(0, 12)}… (${opts.via ?? "server"})`);
    return touched;
  }

  /** Latest checkout-session figures for a reference (server-written at invoice time). */
  async sessionFor(provider: string, ref: string): Promise<{ amount_cents: number | null; amount_sats: number | null } | null> {
    try {
      const rows = await this.rest<Array<{ amount_cents: number | null; amount_sats: number | null }>>(
        `/payment_checkout_sessions?provider=eq.${encodeURIComponent(provider)}` +
        `&provider_payment_id=eq.${encodeURIComponent(ref)}` +
        `&select=amount_cents,amount_sats&order=created_at.desc&limit=1`,
      );
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch {
      return null;
    }
  }

  async rest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!baseUrl || !key) throw new Error("Supabase REST is not configured.");
    const res = await fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.method && init.method !== "GET" ? { Prefer: "return=representation" } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`Supabase REST ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}

/** Same row state the cron reconcile produces, so every path agrees. */
export function paidPatch(table: string, ref: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    payment_status: "paid",
    payment_reference: ref,
    updated_at: new Date().toISOString(),
  };
  if (table === "cleaning_subscriptions") {
    patch.subscription_status = "active";
    patch.is_active = true;
  } else if (table === "rental_bookings") {
    // Confirmed, not active — a rental becomes active when the car is handed over.
    patch.status = "confirmed";
  } else {
    patch.status = "active";
  }
  return patch;
}
