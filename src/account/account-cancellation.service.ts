import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AccountNotificationsService } from "./account-notifications.service";

/**
 * Letting a customer stop a subscription they started.
 *
 * Until this existed there was no way to. The only cancellation on the platform
 * was `cancel_cleaning_booking`, which drops a single visit; the subscription
 * itself could be bought in two clicks and never stopped, and `cancelled` was a
 * status the code read but only an admin could write.
 *
 * **Cancel at the end of the paid period, never immediately.** The customer has
 * paid through `end_date` and is owed those days. So nothing here touches
 * `status` — access checks, the booking page and the nightly expiry sweep go on
 * working exactly as before, and the subscription simply stops renewing and
 * lapses on its own date. It also means the decision is reversible right up to
 * the last day, which "cancel now" would not be.
 *
 * One endpoint for four services rather than four endpoints: the difference
 * between them is three column names, and that belongs in a table, not in
 * copies of the same method.
 */

/** What each service calls the columns this operation needs. */
interface ServiceShape {
  table: string;
  /** Column holding the lifecycle status — cleaning calls it something else. */
  statusCol: string;
  /** Statuses a customer may cancel from. */
  cancellable: string[];
  label: string;
}

const SERVICES: Record<string, ServiceShape> = {
  cleaning: {
    table: "cleaning_subscriptions",
    statusCol: "subscription_status",
    cancellable: ["active", "pending_schedule", "paused"],
    label: "cleaning plan",
  },
  food: {
    table: "food_subscriptions",
    statusCol: "status",
    cancellable: ["active", "paused"],
    label: "meal plan",
  },
  beach: {
    table: "beach_club_subscriptions",
    statusCol: "status",
    cancellable: ["active", "paused"],
    label: "membership",
  },
  plan: {
    table: "provider_subscriptions",
    statusCol: "status",
    cancellable: ["active", "paused"],
    label: "subscription",
  },
};

export type CancellableService = keyof typeof SERVICES;

export interface RentalCancellationResult {
  ok: true;
  status: "cancelled";
  /** True when money had been taken and somebody has to send it back by hand. */
  refundPending: boolean;
  startsOn: string | null;
}

export interface CancellationResult {
  ok: true;
  cancelAtPeriodEnd: boolean;
  /** The day access actually stops. Null when the row has no end date. */
  endsOn: string | null;
}

@Injectable()
export class AccountCancellationService {
  private readonly logger = new Logger(AccountCancellationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: AccountNotificationsService,
  ) {}

  async cancel(userId: string, service: string, subscriptionId: string): Promise<CancellationResult> {
    return this.setFlag(userId, service, subscriptionId, true);
  }

  /** Undo, while the period is still running. */
  async resume(userId: string, service: string, subscriptionId: string): Promise<CancellationResult> {
    return this.setFlag(userId, service, subscriptionId, false);
  }

  private async setFlag(
    userId: string,
    service: string,
    subscriptionId: string,
    cancel: boolean,
  ): Promise<CancellationResult> {
    const shape = SERVICES[service];
    if (!shape) throw new BadRequestException(`Unknown service "${service}".`);

    const rows = await this.rest<any[]>(
      `${shape.table}?id=eq.${encodeURIComponent(subscriptionId)}` +
        `&select=id,user_id,end_date,cancel_at_period_end,${shape.statusCol}&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found.");

    // Ownership, not just existence — the id is guessable and the service key
    // is caller-supplied.
    if (String(sub.user_id ?? "") !== String(userId)) {
      throw new ForbiddenException("This subscription is not yours.");
    }

    const status = String(sub[shape.statusCol] ?? "").toLowerCase();
    if (cancel && !shape.cancellable.includes(status)) {
      // Already over, or already hard-cancelled by an admin. Saying so is
      // better than flipping a flag that changes nothing.
      throw new BadRequestException(
        status === "cancelled" || status === "expired"
          ? "This subscription has already ended."
          : `A ${status} subscription can't be cancelled.`,
      );
    }

    if (Boolean(sub.cancel_at_period_end) === cancel) {
      return { ok: true, cancelAtPeriodEnd: cancel, endsOn: sub.end_date ?? null };
    }

    await this.patch(`${shape.table}?id=eq.${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: cancel,
      cancel_requested_at: cancel ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });

    // A receipt for the decision, so it is not the customer's word against a
    // silent flag. Failure here must not undo the cancellation.
    try {
      await this.notifications.create({
        recipientUserId: String(sub.user_id),
        category: "subscription",
        type: cancel ? "plan_cancelled" : "subscription_created",
        title: cancel ? "Subscription cancelled" : "Subscription resumed",
        body: cancel
          ? sub.end_date
            ? `Your ${shape.label} won't renew. You can keep using it until ${sub.end_date}, and you can undo this until then.`
            : `Your ${shape.label} won't renew.`
          : `Your ${shape.label} will renew as usual.`,
        relatedEntityType: shape.table,
        relatedEntityId: String(sub.id),
        actionUrl: "/my-subscriptions",
      });
    } catch (err) {
      this.logger.warn(`Cancellation notice failed for ${service}:${subscriptionId}: ${(err as Error).message}`);
    }

    this.logger.log(`[cancel] ${service}:${subscriptionId} cancel_at_period_end=${cancel}`);
    return { ok: true, cancelAtPeriodEnd: cancel, endsOn: sub.end_date ?? null };
  }

  /**
   * Cancelling a car rental.
   *
   * Nothing like the subscription case, so it does not share its code. A
   * subscription is paid through a period the customer is owed, so cancelling
   * means "stop renewing" and access continues. A rental is a car held on
   * particular dates: cancelling means the customer is not taking it, and the
   * dates must go back on the calendar immediately — which they do, because
   * every availability query already excludes cancelled bookings.
   *
   * Only before the rental starts. Once the keys are handed over it is a
   * conversation with the provider, not a button, and pretending otherwise
   * would let someone cancel a car they are currently driving.
   *
   * Refunds are deliberately NOT automated. The money went out over Lightning,
   * on-chain, LIVES or PayPal, and there is no reversal path for most of those;
   * the notice says a human will be in touch rather than implying the money is
   * already on its way back.
   */
  async cancelRental(userId: string, bookingId: string): Promise<RentalCancellationResult> {
    const rows = await this.rest<any[]>(
      `rental_bookings?id=eq.${encodeURIComponent(bookingId)}` +
        `&select=id,user_id,status,payment_status,start_date,end_date,total_cents&limit=1`,
    );
    const booking = rows?.[0];
    if (!booking) throw new NotFoundException("Rental not found.");

    if (String(booking.user_id ?? "") !== String(userId)) {
      throw new ForbiddenException("This rental is not yours.");
    }

    const status = String(booking.status ?? "").toLowerCase();
    if (status === "cancelled") {
      return { ok: true, status: "cancelled", refundPending: false, startsOn: booking.start_date ?? null };
    }
    if (["completed", "in_progress", "refunded"].includes(status)) {
      throw new BadRequestException(
        status === "in_progress"
          ? "This rental has already started. Contact us and we'll sort it out with the provider."
          : "This rental is already over.",
      );
    }

    // Honduras-local today, the same day boundary the booking calendar uses.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
    if (booking.start_date && String(booking.start_date) <= today) {
      throw new BadRequestException(
        "This rental starts today or has already begun — contact us and we'll sort it out with the provider.",
      );
    }

    await this.patch(`rental_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
      status: "cancelled",
      updated_at: new Date().toISOString(),
    });

    const refundPending = String(booking.payment_status ?? "").toLowerCase() === "paid";

    try {
      await this.notifications.create({
        recipientUserId: String(booking.user_id),
        category: "booking",
        type: "booking_cancelled",
        title: "Rental cancelled",
        body: refundPending
          ? `Your rental for ${booking.start_date} is cancelled and the dates are free again. We'll be in touch about the refund.`
          : `Your rental for ${booking.start_date} is cancelled and the dates are free again.`,
        relatedEntityType: "rental_bookings",
        relatedEntityId: String(booking.id),
        actionUrl: "/my-subscriptions",
      });
    } catch (err) {
      this.logger.warn(`Rental cancellation notice failed for ${bookingId}: ${(err as Error).message}`);
    }

    this.logger.log(`[cancel] rental:${bookingId} → cancelled (refundPending=${refundPending})`);
    return { ok: true, status: "cancelled", refundPending, startsOn: booking.start_date ?? null };
  }

  // ─── Supabase REST ──────────────────────────────────────────────────────────

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
