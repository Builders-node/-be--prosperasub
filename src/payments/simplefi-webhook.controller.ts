import { Body, Controller, HttpCode, Logger, Post, Headers, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { SimpleFiService } from "./simplefi.service";

// SimpleFi webhook body shape — best-effort typing based on the API response
// spec. Fields marked optional are ones we've seen inconsistently populated,
// or that SimpleFi may add over time.
type SimpleFiWebhookBody = {
  id?: string;                 // payment_request id (their side)
  _id?: string;                // some deployments use _id instead
  status?: string;
  status_detail?: string | null;
  merchant_id?: string;
  amount?: number;
  currency?: string;
  reference?: Record<string, unknown> | null;
  transactions?: Array<Record<string, unknown>>;
};

// Tables our reference.service field can point at. We fan out and match by
// payment_reference (SimpleFi payment id) so the fix works even for rows that
// don't carry the service tag (e.g. legacy rows).
const SUB_TABLES = [
  { table: "cleaning_subscriptions", extra: "&deleted_at=is.null" },
  { table: "food_subscriptions",     extra: "" },
  { table: "beach_club_subscriptions", extra: "" },
  { table: "rental_bookings",        extra: "&deleted_at=is.null" },
] as const;

// SimpleFi statuses treated as successfully paid.
const PAID_STATUSES = new Set(["approved", "paid", "confirmed", "completed"]);

/**
 * Receives status callbacks from SimpleFi (LIVES / Infinita).
 *
 * SimpleFi's `notification_url` on the merchant used to point at
 * `api.infinita.city` — meaning we never received a single webhook and every
 * pending sub had to be reconciled by the cron OR by the user's browser
 * polling. This controller closes that gap: on paid status we update the
 * matching subscription row directly, matching by `payment_reference` (the
 * SimpleFi id we now save on invoice-ready) so we don't need to depend on
 * `reference.service` being set correctly.
 *
 * Endpoint is intentionally on the root path (no /v1 prefix) so it matches
 * whatever URL the merchant config carries.
 */
@ApiExcludeController()
@Controller("webhooks/simplefi")
export class SimpleFiWebhookController {
  private readonly logger = new Logger("SimpleFiWebhook");

  constructor(private readonly simplefi: SimpleFiService) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Body() body: SimpleFiWebhookBody,
    @Headers("x-simplefi-signature") sig: string | undefined,
    @Req() req: Request,
  ) {
    const paymentId = body?.id || body?._id;
    const status = String(body?.status || "").toLowerCase();
    const reference = (body?.reference || {}) as Record<string, unknown>;
    const service = typeof reference.service === "string" ? reference.service : null;
    const orderId = typeof reference.orderId === "string" ? reference.orderId : null;

    this.logger.log(
      `webhook received payment_id=${paymentId} status=${status} service=${service} orderId=${orderId} ip=${req.ip}`,
    );
    if (sig) this.logger.debug(`x-simplefi-signature: ${sig}`);

    if (!paymentId || !status) {
      this.logger.warn("webhook missing payment_id or status — ignoring");
      return { ok: true, ignored: "missing_payment_id_or_status" };
    }

    // Only act on paid statuses for now. Terminal failures (expired/canceled/
    // refunded) don't warrant flipping our row — the user can retry, or admin
    // can cancel. We DO log them for later inspection.
    if (!PAID_STATUSES.has(status)) {
      return { ok: true, status, action: "logged_only" };
    }

    // Belt-and-suspenders: re-verify with SimpleFi's API before applying the
    // status. Prevents spoofed / stale webhooks from marking things paid.
    let verifiedPaid = false;
    try {
      const s = await this.simplefi.getPaymentStatus(paymentId);
      verifiedPaid = s.paid || PAID_STATUSES.has(String(s.status || "").toLowerCase());
    } catch (e) {
      this.logger.warn(`SimpleFi getPaymentStatus failed: ${(e as Error).message}`);
    }
    if (!verifiedPaid) {
      this.logger.warn(`payment ${paymentId} status=${status} in webhook but SimpleFi API disagreed`);
      return { ok: true, status, action: "unverified" };
    }

    // Update strategy: if `reference.service` is present, target that table
    // directly by orderId. Otherwise fan out across all sub tables looking
    // for a row whose payment_reference === paymentId.
    const targeted = await this.updateBySubscription(service, orderId, paymentId);
    if (targeted.updated) {
      return { ok: true, status, action: "updated", ...targeted };
    }

    const fallback = await this.updateByReferenceScan(paymentId);
    return { ok: true, status, action: fallback.updated ? "updated_fallback" : "no_row_found", ...fallback };
  }

  /** Direct update — reference.service + orderId are both set. */
  private async updateBySubscription(service: string | null, orderId: string | null, paymentId: string) {
    if (!service || !orderId) return { updated: false, reason: "no_service_or_orderId" };
    const scope = SUB_TABLES.find((s) => s.table.startsWith(service));
    if (!scope) return { updated: false, reason: `unknown_service_${service}` };
    try {
      await this.rest(
        `/${scope.table}?id=eq.${encodeURIComponent(orderId)}`,
        { method: "PATCH", body: JSON.stringify(this.paidPatch(scope.table, paymentId)) },
      );
      return { updated: true, table: scope.table, id: orderId };
    } catch (e) {
      this.logger.warn(`direct update ${scope.table}/${orderId} failed: ${(e as Error).message}`);
      return { updated: false, reason: "direct_update_failed" };
    }
  }

  /** Fallback — scan every sub table looking for a row that saved this id. */
  private async updateByReferenceScan(paymentId: string) {
    for (const { table, extra } of SUB_TABLES) {
      try {
        const rows = await this.rest<Array<{ id: string }>>(
          `/${table}?select=id&payment_reference=eq.${encodeURIComponent(paymentId)}${extra}&limit=5`,
        );
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (const row of rows) {
          await this.rest(
            `/${table}?id=eq.${encodeURIComponent(row.id)}`,
            { method: "PATCH", body: JSON.stringify(this.paidPatch(table, paymentId)) },
          );
        }
        return { updated: true, table, count: rows.length };
      } catch (e) {
        this.logger.debug(`scan ${table} failed: ${(e as Error).message}`);
      }
    }
    return { updated: false, reason: "no_matching_reference" };
  }

  private paidPatch(table: string, paymentId: string): Record<string, unknown> {
    // Match the shape used by admin.service.reconcilePendingPayments so both
    // the cron reconcile and the webhook produce identical row state.
    const patch: Record<string, unknown> = {
      payment_status: "paid",
      payment_reference: paymentId,
      updated_at: new Date().toISOString(),
    };
    if (table === "cleaning_subscriptions") {
      patch.subscription_status = "active";
      patch.is_active = true;
    } else {
      patch.status = "active";
    }
    return patch;
  }

  private async rest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
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
