import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PayPalService } from "../payments/paypal.service";

/**
 * Giving money back.
 *
 * Until this existed "refunded" was a word in a dropdown. An admin set it, the
 * row left revenue and left the provider's withdrawable balance — every
 * revenue query filters `payment_status = 'paid'`, so that half was already
 * right — and then somebody had to move the actual money by hand, with nothing
 * anywhere recording that they had, or for how much, or whether they ever did.
 *
 * The honest shape of this is that ONE of the three rails can be refunded by
 * software:
 *
 *   paypal   — a capture can be sent back through PayPal's API, in whole or in
 *              part. This does it.
 *   lightning
 *   onchain  — there is no such operation. Bitcoin has no reverse; sending it
 *              back needs an invoice or an address from the customer, which a
 *              refund request does not have and the platform never stored.
 *
 * So for Bitcoin this records an OBLIGATION rather than pretending: the order
 * is marked refunded, the ledger gets a negative row for the amount, and the
 * answer says `manual: true` so the admin is told plainly that they still have
 * to send it. That is worth more than the previous state, where the same
 * manual send happened with no record at all.
 */

export type RefundableTable =
  | "provider_subscriptions"
  | "food_subscriptions"
  | "cleaning_subscriptions"
  | "rental_bookings";

/** How to read the paid amount out of each table, in cents. */
const ORDER_SHAPES: Record<RefundableTable, {
  select: string;
  paidCents: (row: any) => number;
  statusPatch: Record<string, unknown>;
}> = {
  provider_subscriptions: {
    select: "id,user_id,price_cents,surcharge_cents,payment_status,payment_method,payment_reference",
    paidCents: (r) => Number(r.price_cents) || 0,
    statusPatch: { status: "cancelled" },
  },
  food_subscriptions: {
    select: "id,user_id,weekly_price_cents,commitment_weeks,periods_paid,payment_status,payment_method,payment_reference",
    paidCents: (r) =>
      (Number(r.weekly_price_cents) || 0) *
      Math.max(Number(r.commitment_weeks) || 1, 1) *
      Math.max(Number(r.periods_paid) || 1, 1),
    statusPatch: { status: "cancelled" },
  },
  cleaning_subscriptions: {
    select: "id,user_id,total_price_cents,monthly_price_cents,payment_status,payment_method,payment_reference",
    paidCents: (r) => Number(r.total_price_cents) || Number(r.monthly_price_cents) || 0,
    statusPatch: { subscription_status: "cancelled", is_active: false },
  },
  rental_bookings: {
    select: "id,user_id,total_cents,payment_status,payment_method,payment_reference",
    paidCents: (r) => Number(r.total_cents) || 0,
    statusPatch: { status: "cancelled" },
  },
};

export const isRefundableTable = (v: string): v is RefundableTable =>
  Object.prototype.hasOwnProperty.call(ORDER_SHAPES, v);

export interface RefundResult {
  ok: true;
  amountCents: number;
  /** True when the platform could not send the money and a person must. */
  manual: boolean;
  method: string | null;
  providerRefundId: string | null;
  note: string;
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly paypal: PayPalService,
  ) {}

  async refund(
    table: string,
    orderId: string,
    input: { amountCents?: number; reason?: string; adminUserId?: string },
  ): Promise<RefundResult> {
    if (!isRefundableTable(table)) throw new BadRequestException("Unknown order type.");
    const shape = ORDER_SHAPES[table];

    const [order] = await this.rest<any[]>(
      `/${table}?id=eq.${encodeURIComponent(orderId)}&select=${shape.select}&limit=1`,
    ) ?? [];
    if (!order) throw new NotFoundException("Order not found.");
    if (order.payment_status === "refunded") {
      throw new BadRequestException("This order has already been refunded.");
    }
    if (order.payment_status !== "paid") {
      throw new BadRequestException("Only a paid order can be refunded.");
    }

    const paid = shape.paidCents(order);
    const amount = Math.round(input.amountCents ?? paid);
    if (amount <= 0) throw new BadRequestException("A refund has to be more than nothing.");
    if (amount > paid) {
      throw new BadRequestException(`That is more than was paid (${this.usd(paid)}).`);
    }

    const method = String(order.payment_method ?? "").toLowerCase() || null;
    let manual = true;
    let providerRefundId: string | null = null;
    let note: string;

    if (method === "paypal" && order.payment_reference) {
      // The reference stored on a paid PayPal row is the CAPTURE id, which is
      // what PayPal refunds against.
      const res = await this.paypal.refundCapture(String(order.payment_reference), amount);
      manual = false;
      providerRefundId = res.refund_id;
      note = `PayPal refund ${res.status}`;
    } else if (method === "lightning" || method === "onchain") {
      note = "Bitcoin cannot be sent back automatically — pay the customer directly and keep this record as the reason.";
    } else {
      note = "Paid off platform, so it goes back off platform too.";
    }

    // The money side is recorded whether or not software moved it: a negative
    // ledger row, keyed to the order, so the figure exists somewhere other
    // than in somebody's memory.
    await this.recordLedger(table, order, amount, method, providerRefundId, input);

    // Partial refunds leave the order paid — the customer still has what is
    // left of it. Only a full one ends the thing.
    const full = amount >= paid;
    await this.rest(`/${table}?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(full ? { payment_status: "refunded", ...shape.statusPatch } : {}),
        updated_at: new Date().toISOString(),
      }),
    });

    this.logger.log(`refund ${this.usd(amount)} on ${table}:${orderId} (${method ?? "no method"}, manual=${manual})`);
    return { ok: true, amountCents: amount, manual, method, providerRefundId, note };
  }

  private async recordLedger(
    table: string,
    order: any,
    amountCents: number,
    method: string | null,
    providerRefundId: string | null,
    input: { reason?: string; adminUserId?: string },
  ) {
    try {
      await this.rest(`/payments`, {
        method: "POST",
        body: JSON.stringify({
          // Negative, because the ledger is a ledger: the sum of it is what
          // the platform actually took.
          amount_cents: -Math.abs(amountCents),
          currency: "USD",
          method: method ?? "manual",
          provider: method === "paypal" ? "paypal" : "manual",
          provider_payment_id: providerRefundId ?? `refund:${table}:${order.id}`,
          status: "refunded",
          subject_ref: `subscription:${order.id}`,
          metadata: {
            refund: true,
            order_table: table,
            order_id: String(order.id),
            reason: input.reason ?? null,
            refunded_by: input.adminUserId ?? null,
            manual: !providerRefundId,
          },
        }),
      });
    } catch (err) {
      // A refund that moved real money must not be lost because the ledger
      // insert failed; it is logged loudly instead.
      this.logger.error(`refund ledger row failed for ${table}:${order.id}: ${(err as Error).message}`);
    }
  }

  private usd(cents: number) { return `$${(cents / 100).toFixed(2)}`; }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new BadRequestException("Supabase service credentials are missing.");
    const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }
}
