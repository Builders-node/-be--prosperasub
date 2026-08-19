import { Body, Controller, HttpCode, Logger, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { BlinkService } from "./blink.service";
import { BillingService } from "../billing/billing.service";

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

const SUB_TABLES = [
  { table: "cleaning_subscriptions", extra: "&deleted_at=is.null" },
  { table: "food_subscriptions",     extra: "" },
  // The beach's memberships are universal rows; the legacy twin follows by
  // trigger, so verifying the old table would confirm a payment against a
  // copy and leave the row this platform now considers the real one pending.
  { table: "provider_subscriptions", extra: "&source_service_key=eq.beach" },
] as const;

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
    private readonly billing: BillingService,
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
      paid = isHash
        ? (await this.blink.getPaymentStatus(ref)).paid
        : (await this.blink.getOnchainStatus(ref)).paid;
    } catch (e) {
      this.logger.debug(`blink lookup failed for ${ref.slice(0, 12)}…: ${(e as Error).message}`);
      return false;
    }
    if (!paid) return false;
    return this.markPaidByReference(ref, isHash ? "lightning" : "onchain");
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
    for (const { table, extra } of SUB_TABLES) {
      let rows: Array<{ id: string; payment_reference: string; payment_method: string }> = [];
      try {
        rows = await this.rest(
          `/${table}?select=id,payment_reference,payment_method&payment_status=neq.paid` +
          `&payment_reference=not.is.null&payment_method=in.(lightning,onchain,blink)${extra}` +
          `&order=created_at.desc&limit=${FALLBACK_SCAN_LIMIT}`,
        );
      } catch {
        continue;
      }
      for (const row of rows ?? []) {
        if (await this.settleReference(String(row.payment_reference))) confirmed++;
      }
    }
    return confirmed;
  }

  /** Flip every row holding this reference, and record it in the ledger once. */
  private async markPaidByReference(ref: string, method: "lightning" | "onchain"): Promise<boolean> {
    let touched = false;
    for (const { table, extra } of SUB_TABLES) {
      try {
        const rows = await this.rest<Array<{ id: string }>>(
          `/${table}?select=id&payment_reference=eq.${encodeURIComponent(ref)}&payment_status=neq.paid${extra}&limit=5`,
        );
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (const row of rows) {
          await this.rest(
            `/${table}?id=eq.${encodeURIComponent(row.id)}`,
            { method: "PATCH", body: JSON.stringify(this.paidPatch(table, ref)) },
          );
          touched = true;
          // Idempotent per (provider, ref) — a webhook that arrives twice, or
          // after the cron already saw it, records and emits once.
          await this.billing.recordCaptured({
            method,
            provider: "blink",
            providerRef: ref,
            subjectRef: `subscription:${row.id}`,
            metadata: { table, viaWebhook: true },
          }).catch((e) => this.logger.warn(`ledger write failed: ${(e as Error).message}`));
        }
      } catch (e) {
        this.logger.debug(`scan ${table} failed: ${(e as Error).message}`);
      }
    }
    if (touched) this.logger.log(`confirmed ${method} payment ${ref.slice(0, 12)}… via webhook`);
    return touched;
  }

  /** Same row state the cron reconcile produces, so both paths agree. */
  private paidPatch(table: string, ref: string): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      payment_status: "paid",
      payment_reference: ref,
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

  private async rest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
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
