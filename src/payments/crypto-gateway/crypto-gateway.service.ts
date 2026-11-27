import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../../notifications/notifications.service";
import { PaymentSettlementService } from "../payment-settlement.service";
import { CRYPTO_GATEWAY_METHOD, type CryptoGateway, type CryptoPayment } from "./crypto-gateway.port";
import { NowPaymentsGateway } from "./nowpayments.gateway";
import type { RenewalService } from "../subscription-renewal.service";
import { decodeRenewalOrderId, encodeRenewalOrderId, type RenewalHandler } from "./crypto-renewals";

/** Coins that never go through the gateway: Bitcoin already has its own two rails (Blink). */
const ALWAYS_EXCLUDED = new Set(["btc", "btcln", "lnbtc"]);

export interface CheckoutMeta {
  service_name?: string;
  client_name?: string;
  client_email?: string;
  client_phone?: string;
  plan_name?: string;
  duration?: string;
  booking_id?: string;
  admin_url?: string;
  selected_date_time?: string;
  context?: string;
  description?: string;
  /** Set when this payment renews an existing subscription. */
  renew_service?: RenewalService;
  renew_subscription_id?: string;
  /** Service price and method fee of the renewal (the split the ledger keeps). */
  renew_amount_cents?: number;
  renew_surcharge_cents?: number;
}

/**
 * The platform's side of crypto-gateway payments: which gateway is active,
 * which coins are offered, and what "paid" means once the gateway has spoken.
 *
 * Picking the gateway: `CRYPTO_GATEWAY` env (`nowpayments` today). To add
 * another, implement `CryptoGateway` and add a case in `resolveGateway` —
 * nothing else in the app knows which one it is.
 */
@Injectable()
export class CryptoGatewayService {
  private readonly logger = new Logger("CryptoGateway");
  private readonly gateway: CryptoGateway | null;
  /** Who extends each service's subscription — registered by the modules that own them. */
  private readonly renewalHandlers = new Map<RenewalService, RenewalHandler>();

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly settlement: PaymentSettlementService,
  ) {
    this.gateway = this.resolveGateway();
  }

  private resolveGateway(): CryptoGateway | null {
    const nowKey = this.config.get<string>("NOWPAYMENTS_API_KEY");
    const which = (this.config.get<string>("CRYPTO_GATEWAY") || (nowKey ? "nowpayments" : "")).toLowerCase();
    switch (which) {
      case "nowpayments":
        return new NowPaymentsGateway(
          nowKey,
          this.config.get<string>("NOWPAYMENTS_IPN_SECRET"),
          this.config.get<string>("NOWPAYMENTS_SANDBOX") === "true",
        );
      // case "coingate": return new CoinGateGateway(...);
      default:
        return null;
    }
  }

  /** The concrete gateway key (`nowpayments`) — the checkout-session / ledger provider. */
  get providerKey(): string | null {
    return this.gateway?.id ?? null;
  }

  get enabled(): boolean {
    return Boolean(this.gateway?.isConfigured());
  }

  private require(): CryptoGateway {
    if (!this.gateway || !this.gateway.isConfigured()) {
      throw new ServiceUnavailableException("Crypto payments are not configured.");
    }
    return this.gateway;
  }

  /**
   * Coins on offer: what the gateway dashboard has switched on, narrowed by
   * `CRYPTO_GATEWAY_CURRENCIES` (comma list) when set, never Bitcoin.
   */
  async currencies(): Promise<string[]> {
    const gw = this.require();
    const allow = (this.config.get<string>("CRYPTO_GATEWAY_CURRENCIES") || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    let codes: string[] = [];
    try {
      codes = (await gw.listCurrencies()).map((c) => c.code);
    } catch (e) {
      // The dashboard list is a nicety; an explicit allowlist still works without it.
      this.logger.warn(`listCurrencies failed: ${(e as Error).message}`);
      codes = allow;
    }
    if (allow.length) codes = codes.filter((c) => allow.includes(c));
    return [...new Set(codes)].filter((c) => !ALWAYS_EXCLUDED.has(c));
  }

  async createPayment(input: { amountCents: number; payCurrency: string; meta: CheckoutMeta }): Promise<CryptoPayment> {
    const gw = this.require();
    const code = input.payCurrency.toLowerCase();
    const offered = await this.currencies();
    if (offered.length && !offered.includes(code)) {
      throw new ServiceUnavailableException(`${code.toUpperCase()} is not accepted right now.`);
    }

    const description = input.meta.description || input.meta.service_name || "EverySub payment";
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const renewal = input.meta.renew_service && input.meta.renew_subscription_id
      ? {
          service: input.meta.renew_service,
          subscriptionId: input.meta.renew_subscription_id,
          amountCents: input.meta.renew_amount_cents ?? input.amountCents,
          surchargeCents: input.meta.renew_surcharge_cents ?? 0,
        }
      : null;
    if (renewal && renewal.amountCents + renewal.surchargeCents > input.amountCents + 1) {
      throw new ServiceUnavailableException("Renewal amount does not match the payment.");
    }
    const payment = await gw.createPayment({
      amountCents: input.amountCents,
      payCurrency: code,
      // A renewal carries what it renews in the gateway's own order id, so the
      // webhook can finish it server-side (see crypto-renewals.ts).
      orderId: renewal ? encodeRenewalOrderId(renewal, nonce) : `es-${nonce}`,
      description,
      callbackUrl: `${this.apiBaseUrl()}/webhooks/crypto/${gw.id}`,
    });

    // Written server-side at invoice time: this — not anything the browser
    // sends later — is what the ledger and the amount check trust.
    await this.notifications.recordCheckoutSession({
      provider: gw.id,
      providerPaymentId: payment.paymentId,
      // `renewal:*` is what the sweep looks for when a webhook never came.
      context: renewal ? `renewal:${renewal.service}:${renewal.subscriptionId}` : input.meta.context,
      serviceName: input.meta.service_name || description,
      clientName: input.meta.client_name ?? null,
      clientEmail: input.meta.client_email ?? null,
      clientPhone: input.meta.client_phone ?? null,
      amountCents: input.amountCents,
      amountSats: null,
      currency: "USD",
      planName: input.meta.plan_name ?? null,
      duration: input.meta.duration ?? null,
      bookingId: input.meta.booking_id ?? null,
      adminUrl: input.meta.admin_url ?? null,
      selectedDateTime: input.meta.selected_date_time ?? null,
      description,
    });

    return payment;
  }

  /**
   * Ask the gateway, then hold its answer against what WE priced the order at.
   *
   * The gateway's own `paid` is necessary but not sufficient: a payment id is
   * something the browser hands us, so a cheap order's id presented for an
   * expensive one must not settle it. The session amount was written by this
   * server when the payment was created.
   */
  async verify(paymentId: string): Promise<CryptoPayment & { paid: boolean }> {
    const gw = this.require();
    const payment = await gw.getPayment(paymentId);
    let paid = payment.state === "paid";
    if (paid) {
      const session = await this.settlement.sessionFor(gw.id, paymentId);
      const expected = session?.amount_cents ?? null;
      if (expected != null && payment.priceCents != null && payment.priceCents + 1 < expected) {
        this.logger.warn(`payment ${paymentId} priced ${payment.priceCents}¢ but session expects ${expected}¢ — not settling`);
        paid = false;
      }
    }
    return { ...payment, paid };
  }

  /**
   * Stricter than verify(), for a payment that must pay a specific amount
   * (a renewal): the payment must be one this server raised — its checkout
   * session exists — and both the session and the gateway's price must cover
   * `minCents`. verify() alone lets a payment with no session through, which
   * is fine for settling the order it was raised for, not for paying another.
   */
  async paidFor(paymentId: string, minCents: number): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
    if (!this.enabled) return { ok: false, reason: "not_configured" };
    const gw = this.require();
    const session = await this.settlement.sessionFor(gw.id, paymentId);
    if (!session) return { ok: false, reason: "unknown_payment" };
    // A cent of rounding between the fee calculation and the invoice is not a shortfall.
    if ((session.amount_cents ?? 0) + 1 < minCents) return { ok: false, reason: "amount_too_low" };
    const payment = await this.verify(paymentId);
    if (!payment.paid) return { ok: false, reason: `not_paid:${payment.rawStatus}` };
    if (payment.priceCents == null || payment.priceCents + 1 < minCents) return { ok: false, reason: "amount_too_low" };
    return { ok: true, status: payment.rawStatus };
  }

  /** A module that owns a subscription service says how to extend one. */
  registerRenewalHandler(service: RenewalService, handler: RenewalHandler): void {
    this.renewalHandlers.set(service, handler);
  }

  /**
   * Verified payment → rows flipped, ledger written, team told; or, for a
   * renewal, the subscription extended. Idempotent with the browser's own
   * renewal call, the webhook and the cron.
   */
  async settle(paymentId: string, via: string, payment?: CryptoPayment): Promise<boolean> {
    const gw = this.require();
    const settled = await this.settlement.markPaidByReference(paymentId, {
      method: CRYPTO_GATEWAY_METHOD,
      billingProvider: gw.id,
      sessionProvider: gw.id,
      via,
    });
    const renewed = await this.settleRenewal(paymentId, via, payment);
    return settled || renewed;
  }

  /** Extend the subscription a paid renewal payment was raised for. */
  private async settleRenewal(paymentId: string, via: string, payment?: CryptoPayment): Promise<boolean> {
    const gw = this.require();
    const orderId = payment?.orderId !== undefined ? payment.orderId : (await gw.getPayment(paymentId)).orderId;
    const intent = decodeRenewalOrderId(orderId);
    if (!intent) return false;
    const handler = this.renewalHandlers.get(intent.service);
    if (!handler) {
      this.logger.warn(`renewal ${paymentId}: no handler for ${intent.service}`);
      return false;
    }
    try {
      const r: any = await handler(intent, paymentId);
      if (r?.idempotent) return false;
      this.logger.log(`renewal ${paymentId} → ${intent.service}/${intent.subscriptionId} extended (${via})`);
      return true;
    } catch (e) {
      // Already renewed by the browser, or refused (cancelled, underpaid):
      // nothing more this path can do; the reason is in the log.
      this.logger.warn(`renewal ${paymentId} not applied (${via}): ${(e as Error).message}`);
      return false;
    }
  }

  /** Re-check what we are still waiting on (webhook with no usable hint, the cron). */
  async sweepPending(limit = 25): Promise<number> {
    let confirmed = await this.sweepRenewals(limit);
    const rows = await this.settlement.pendingReferences([CRYPTO_GATEWAY_METHOD], limit);
    for (const row of rows) {
      try {
        if ((await this.verify(row.ref)).paid && (await this.settle(row.ref, "viaSweep"))) confirmed++;
      } catch {
        continue;
      }
    }
    return confirmed;
  }

  /** Renewals paid in the last 3 days that no renewal row carries yet. */
  async sweepRenewals(limit = 25): Promise<number> {
    if (!this.enabled) return 0;
    const gw = this.require();
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    let renewed = 0;
    for (const ref of await this.settlement.unsettledRenewalRefs(gw.id, since, limit)) {
      try {
        const p = await this.verify(ref);
        if (p.paid && (await this.settleRenewal(ref, "viaSweep", p))) renewed++;
      } catch {
        continue;
      }
    }
    return renewed;
  }

  verifyCallback(gatewayId: string, body: unknown, headers: Record<string, string | string[] | undefined>) {
    if (!this.gateway || this.gateway.id !== gatewayId) return { trusted: false, paymentId: null as string | null };
    return {
      trusted: this.gateway.verifyCallback(body, headers),
      paymentId: this.gateway.paymentIdFromCallback(body),
    };
  }

  private apiBaseUrl(): string {
    return (this.config.get<string>("API_PUBLIC_URL") || "https://api.prosperasub.com").replace(/\/+$/, "");
  }
}
