import { Body, Controller, HttpCode, Logger, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { BlinkService } from "./blink.service";
import { PaymentSettlementService } from "./payment-settlement.service";

/**
 * Receives payment callbacks from Blink (Lightning + on-chain Bitcoin).
 *
 * Until now Blink had no callback at all: a payment was noticed either by the
 * customer's own browser polling, or by the reconcile cron — which Vercel runs
 * once a day at 06:00 UTC. Close the tab after paying on-chain and the order
 * sat unconfirmed for up to 23 hours.
 *
 * The design deliberately does not trust the request body. Blink's payload
 * shape is not something this codebase should encode a guess about, and a
 * webhook URL is public. So the body is used only as a HINT about which
 * payment moved; every decision is made by asking Blink itself. If the hint is
 * unreadable, the endpoint falls back to re-checking our own pending Blink
 * rows — which makes it useful whatever the payload turns out to look like,
 * and harmless if someone POSTs noise at it.
 *
 * Root path (no /v1 prefix) so it matches whatever URL is registered with
 * Blink.
 */

/** How many pending rows the blind fallback will verify in one call. */
const FALLBACK_SCAN_LIMIT = 25;

/** A 64-char hex string is a Lightning payment hash. */
const HASH_RE = /^[0-9a-f]{64}$/i;
/** bech32 or base58 Bitcoin address, main or test net. */
const ADDRESS_RE = /^(bc1|tb1|[13mn2])[a-z0-9]{20,80}$/i;

export const isPaymentHash = (v: string) => HASH_RE.test(v);

/**
 * Every string in a payload that could be a payment hash or an on-chain
 * address. Deliberately greedy and shape-agnostic: a wrong guess costs one
 * Blink lookup that returns "not paid", and a right guess saves a day.
 *
 * Exported so the guessing — the one part of this file that is a guess about
 * someone else's payload — can be tested without a webhook.
 */
export function extractPaymentHints(body: unknown, limit = 20): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || out.size >= limit) return;
    if (typeof value === "string") {
      const v = value.trim();
      if (HASH_RE.test(v) || ADDRESS_RE.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, depth + 1)); return; }
    if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach((v) => walk(v, depth + 1));
    }
  };
  walk(body, 0);
  return [...out];
}

@ApiExcludeController()
@Controller("webhooks/blink")
export class BlinkWebhookController {
  private readonly logger = new Logger("BlinkWebhook");

  constructor(
    private readonly blink: BlinkService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: Record<string, unknown>, @Req() req: Request) {
    this.logger.log(`webhook received ip=${req.ip} keys=${Object.keys(body ?? {}).join(",")}`);

    const hints = extractPaymentHints(body ?? {});
    let confirmed = 0;

    for (const hint of hints) {
      if (await this.settleReference(hint)) confirmed++;
    }

    if (confirmed > 0) return { ok: true, action: "confirmed", confirmed, hints: hints.length };

    // No usable hint, or the hinted payment isn't ours: re-check what we are
    // actually waiting on. This is the whole point of the endpoint — "Blink
    // says something happened" is reason enough to look.
    const swept = await this.sweepPending();
    return { ok: true, action: swept ? "confirmed_by_sweep" : "nothing_to_do", confirmed: swept };
  }

  /** Ask Blink whether this reference is paid, and if so settle the row. */
  private async settleReference(ref: string): Promise<boolean> {
    const isHash = isPaymentHash(ref);
    let paid = false;
    try {
      if (isHash) {
        paid = (await this.blink.getPaymentStatus(ref)).paid;
      } else {
        // Pass the expected sats so an underpaid on-chain tx can't settle here.
        const expectedSats = await this.expectedOnchainSats(ref);
        paid = (await this.blink.getOnchainStatus(ref, expectedSats)).paid;
      }
    } catch (e) {
      this.logger.debug(`blink lookup failed for ${ref.slice(0, 12)}…: ${(e as Error).message}`);
      return false;
    }
    if (!paid) return false;
    return this.markPaidByReference(ref, isHash ? "lightning" : "onchain");
  }

  /**
   * Expected sats for an on-chain address, from the checkout session written
   * server-side at invoice time (keyed by the address). Passing it into
   * getOnchainStatus stops a webhook confirming an underpayment — "send 100
   * sats, get a $500 plan". Undefined when no amount is on file, in which case
   * getOnchainStatus keeps its prior behaviour rather than stranding a payment.
   */
  private async expectedOnchainSats(address: string): Promise<number | undefined> {
    try {
      const rows = await this.rest<Array<{ amount_sats: number | null }>>(
        `/payment_checkout_sessions?provider_payment_id=eq.${encodeURIComponent(address)}` +
        `&select=amount_sats&order=created_at.desc&limit=1`,
      );
      const sats = Array.isArray(rows) ? rows[0]?.amount_sats : null;
      return typeof sats === "number" && sats > 0 ? sats : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Verify the Blink payments we are still waiting on.
   *
   * Bounded and cheap: only rows that already carry a reference, only the two
   * Blink methods, newest first. Rows without a reference cannot be checked at
   * all — the daily cron expires those.
   */
  private async sweepPending(): Promise<number> {
    let confirmed = 0;
    const rows = await this.settlement.pendingReferences(["lightning", "onchain", "blink"], FALLBACK_SCAN_LIMIT);
    for (const row of rows) {
      if (await this.settleReference(row.ref)) confirmed++;
    }
    return confirmed;
  }

  private markPaidByReference(ref: string, method: "lightning" | "onchain"): Promise<boolean> {
    return this.settlement.markPaidByReference(ref, {
      method,
      billingProvider: "blink",
      sessionProvider: method === "onchain" ? "blink-onchain" : "blink",
      via: "viaWebhook",
    });
  }

  private rest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    return this.settlement.rest<T>(path, init);
  }
}
