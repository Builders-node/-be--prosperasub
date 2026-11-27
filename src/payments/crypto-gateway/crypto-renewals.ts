import { createHash } from "crypto";
import type { RenewalService } from "../subscription-renewal.service";

/**
 * A renewal paid through the crypto gateway, written into the gateway's own
 * `order_id` when the payment is created. The webhook reads it back from the
 * gateway (GET /payment/:id — never from the callback body), so the server can
 * extend the subscription itself when the customer has already closed the tab.
 *
 *   ren:<service>:<subscriptionId>:<amountCents>:<surchargeCents>:<nonce>
 *
 * `amountCents` is the service price, `surchargeCents` the method's fee — the
 * same split the browser sends to the renewal endpoint, so both paths write
 * the same `subscription_renewals` row.
 */
export interface RenewalIntent {
  service: RenewalService;
  subscriptionId: string;
  amountCents: number;
  surchargeCents: number;
}

const SERVICES: RenewalService[] = ["food", "cleaning", "beach", "plan"];
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;

export function isRenewalService(v: unknown): v is RenewalService {
  return typeof v === "string" && (SERVICES as string[]).includes(v);
}

export function encodeRenewalOrderId(intent: RenewalIntent, nonce: string): string {
  if (!isRenewalService(intent.service)) throw new Error(`Unknown renewal service: ${intent.service}`);
  if (!ID_RE.test(intent.subscriptionId)) throw new Error("Invalid subscription id");
  const amount = Math.max(0, Math.round(intent.amountCents));
  const fee = Math.max(0, Math.round(intent.surchargeCents));
  return `ren:${intent.service}:${intent.subscriptionId}:${amount}:${fee}:${nonce}`;
}

export function decodeRenewalOrderId(orderId: string | null | undefined): RenewalIntent | null {
  const parts = String(orderId ?? "").split(":");
  if (parts.length !== 6 || parts[0] !== "ren") return null;
  const [, service, subscriptionId, amount, fee] = parts;
  if (!isRenewalService(service) || !ID_RE.test(subscriptionId)) return null;
  const amountCents = Number(amount);
  const surchargeCents = Number(fee);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || !Number.isInteger(surchargeCents) || surchargeCents < 0) return null;
  return { service, subscriptionId, amountCents, surchargeCents };
}

/**
 * The one idempotency key a gateway payment ever renews under. The browser's
 * call and the webhook's call then land on the same (subscription, key) row:
 * whichever is second gets the first one's outcome instead of an error.
 */
export function renewalIdempotencyKey(paymentId: string): string {
  const h = createHash("sha256").update(`crypto-renewal:${paymentId}`).digest("hex");
  // Shaped as a v4-style UUID (the column and DTOs expect one).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Extends one service's subscription from a verified gateway payment. */
export type RenewalHandler = (intent: RenewalIntent, paymentId: string) => Promise<unknown>;
