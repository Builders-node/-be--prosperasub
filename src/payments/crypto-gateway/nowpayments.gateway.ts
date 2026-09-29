import { Logger, ServiceUnavailableException, BadRequestException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import type {
  CreateCryptoPaymentInput,
  CryptoCurrency,
  CryptoGateway,
  CryptoPayment,
  CryptoPaymentState,
} from "./crypto-gateway.port";

/**
 * NOWPayments (nowpayments.io) behind the crypto-gateway port.
 *
 * White-label flow (`POST /payment`), not the hosted invoice page: the
 * customer stays on our checkout, picks a coin, and sees an address + exact
 * amount + QR — the same experience as the Bitcoin rails.
 *
 * Env:
 *   NOWPAYMENTS_API_KEY     — dashboard → Store settings → API keys
 *   NOWPAYMENTS_IPN_SECRET  — dashboard → Store settings → IPN secret
 *   NOWPAYMENTS_SANDBOX     — "true" to use api-sandbox.nowpayments.io
 */

const LIVE_URL = "https://api.nowpayments.io/v1";
const SANDBOX_URL = "https://api-sandbox.nowpayments.io/v1";

/**
 * NOWPayments status → platform state.
 *
 * `confirmed` (on-chain confirmed, being forwarded) and `sending` (on its way
 * to our payout wallet) already mean the customer's money is final; waiting
 * for `finished` would only delay activation by the forwarding time.
 * `partially_paid` is NOT paid — it is how the gateway reports an underpayment.
 */
export function mapNowPaymentsStatus(status: string | null | undefined): CryptoPaymentState {
  switch (String(status || "").toLowerCase()) {
    case "finished":
    case "confirmed":
    case "sending":
      return "paid";
    case "confirming":
      return "confirming";
    case "partially_paid":
      return "partial";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    case "waiting":
    default:
      return "waiting";
  }
}

/** Keys sorted at every depth — NOWPayments signs `JSON.stringify` of that. */
export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/** HMAC-SHA512 over the key-sorted JSON body, hex — the `x-nowpayments-sig` value. */
export function nowPaymentsSignature(body: unknown, secret: string): string {
  return createHmac("sha512", secret).update(JSON.stringify(sortDeep(body))).digest("hex");
}

export function verifyNowPaymentsSignature(body: unknown, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(nowPaymentsSignature(body, secret), "utf8");
  const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** USD decimal → cents, without float drift ("79.9" → 7990). */
export function usdToCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function toCryptoPayment(res: any): CryptoPayment {
  return {
    paymentId: String(res?.payment_id ?? ""),
    state: mapNowPaymentsStatus(res?.payment_status),
    rawStatus: String(res?.payment_status ?? "unknown"),
    payAddress: res?.pay_address ?? null,
    payExtraId: res?.payin_extra_id ?? null,
    payAmount: res?.pay_amount != null ? String(res.pay_amount) : null,
    payCurrency: res?.pay_currency ? String(res.pay_currency).toLowerCase() : null,
    priceCents: usdToCents(res?.price_amount),
    expiresAt: res?.expiration_estimate_date ?? null,
  };
}

export class NowPaymentsGateway implements CryptoGateway {
  readonly id = "nowpayments";
  private readonly logger = new Logger("NowPayments");

  constructor(
    private readonly apiKey: string | undefined,
    private readonly ipnSecret: string | undefined,
    private readonly sandbox: boolean,
  ) {}

  private get baseUrl() {
    return this.sandbox ? SANDBOX_URL : LIVE_URL;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Coins switched on in the NOWPayments dashboard — the dashboard is the source of truth. */
  async listCurrencies(): Promise<CryptoCurrency[]> {
    const res = await this.call("GET", "/merchant/coins");
    const list: unknown[] = Array.isArray(res?.selectedCurrencies) ? res.selectedCurrencies : [];
    return list
      .map((c) => String(c).toLowerCase().trim())
      .filter(Boolean)
      .map((code) => ({ code }));
  }

  async createPayment(input: CreateCryptoPaymentInput): Promise<CryptoPayment> {
    const res = await this.call("POST", "/payment", {
      price_amount: Number((input.amountCents / 100).toFixed(2)),
      price_currency: "usd",
      pay_currency: input.payCurrency,
      order_id: input.orderId,
      order_description: input.description.slice(0, 200),
      ipn_callback_url: input.callbackUrl,
      // Fixed rate: the amount shown is the amount owed, for the whole
      // validity window. Floating would let a price move turn an exact payment
      // into `partially_paid`.
      is_fixed_rate: true,
      is_fee_paid_by_user: false,
    });
    const payment = toCryptoPayment(res);
    if (!payment.paymentId || !payment.payAddress) {
      throw new ServiceUnavailableException("NOWPayments did not return a payment address.");
    }
    return payment;
  }

  async getPayment(paymentId: string): Promise<CryptoPayment> {
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(paymentId)) throw new BadRequestException("Invalid payment id.");
    return toCryptoPayment(await this.call("GET", `/payment/${encodeURIComponent(paymentId)}`));
  }

  verifyCallback(body: unknown, headers: Record<string, string | string[] | undefined>): boolean {
    const raw = headers["x-nowpayments-sig"];
    const sig = Array.isArray(raw) ? raw[0] : raw;
    return verifyNowPaymentsSignature(body, sig, this.ipnSecret ?? "");
  }

  paymentIdFromCallback(body: unknown): string | null {
    const id = (body as any)?.payment_id;
    return id === undefined || id === null ? null : String(id);
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    if (!this.apiKey) throw new ServiceUnavailableException("Crypto payments are not configured.");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = json?.message || text || res.statusText;
      this.logger.warn(`${method} ${path} → ${res.status}: ${String(msg).slice(0, 300)}`);
      // 4xx is usually the customer's choice (amount under the coin's minimum,
      // coin switched off) — say so rather than "service unavailable".
      if (res.status >= 400 && res.status < 500) throw new BadRequestException(String(msg).slice(0, 200));
      throw new ServiceUnavailableException("The crypto payment provider returned an error.");
    }
    return json;
  }
}
