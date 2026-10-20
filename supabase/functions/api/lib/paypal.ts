import { db } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * PayPal REST client for Subscriptions (Billing Plans + Subscriptions v1).
 *
 * One set of credentials per environment. The function deployed as `api-dev`
 * uses PAYPAL_SANDBOX_* when those secrets exist, so dev can be tried without
 * real money; otherwise both functions use the live PAYPAL_* keys.
 */

export type PayPalEnv = "live" | "sandbox";

/** Set by index.ts from the request path: "api" or "api-dev". */
export function functionName(): string {
  return (globalThis as { __fnName?: string }).__fnName ?? "api";
}

export function paypalConfig() {
  const dev = functionName() === "api-dev";
  const sandboxId = Deno.env.get("PAYPAL_SANDBOX_CLIENT_ID");
  if (dev && sandboxId) {
    return {
      env: "sandbox" as PayPalEnv,
      clientId: sandboxId,
      secret: Deno.env.get("PAYPAL_SANDBOX_CLIENT_SECRET") ?? "",
      base: "https://api-m.sandbox.paypal.com",
      webhookId: Deno.env.get("PAYPAL_SANDBOX_WEBHOOK_ID") ?? "",
    };
  }
  const env: PayPalEnv = (Deno.env.get("PAYPAL_ENV") ?? "live") === "sandbox" ? "sandbox" : "live";
  return {
    env,
    clientId: Deno.env.get("PAYPAL_CLIENT_ID") ?? "",
    secret: Deno.env.get("PAYPAL_CLIENT_SECRET") ?? "",
    base: env === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com",
    webhookId: (dev ? Deno.env.get("PAYPAL_WEBHOOK_ID_DEV") : Deno.env.get("PAYPAL_WEBHOOK_ID")) ?? "",
  };
}

let cached: { token: string; until: number; key: string } | null = null;

async function token(): Promise<string> {
  const cfg = paypalConfig();
  if (!cfg.clientId || !cfg.secret) throw new HttpError(503, "PayPal is not configured.");
  const key = cfg.clientId;
  if (cached && cached.key === key && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${cfg.base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new HttpError(503, "PayPal authentication failed.");
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 300) * 1000, key };
  return cached.token;
}

export async function paypal<T = any>(path: string, init: { method?: string; body?: unknown; requestId?: string } = {}): Promise<T> {
  const cfg = paypalConfig();
  const res = await fetch(`${cfg.base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 204) return {} as T;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[paypal] ${init.method ?? "GET"} ${path} → ${res.status}`, JSON.stringify(j).slice(0, 500));
    throw new HttpError(502, j?.message || j?.details?.[0]?.description || "PayPal rejected the request.");
  }
  return j as T;
}

/** Our period vocabulary (lib/services/planPeriod.ts) → PayPal billing interval. */
export function intervalFor(period: string | null | undefined): { unit: "WEEK" | "MONTH" | "YEAR"; count: number } | null {
  const p = String(period ?? "monthly").trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (p) {
    case "weekly": return { unit: "WEEK", count: 1 };
    case "monthly": case "month": return { unit: "MONTH", count: 1 };
    case "quarterly": return { unit: "MONTH", count: 3 };
    case "yearly": return { unit: "YEAR", count: 1 };
    default: return null; // one_time and anything unknown cannot auto-renew
  }
}

const usd = (cents: number) => (cents / 100).toFixed(2);

/**
 * The PayPal plan for (our plan, price, interval) in this environment, created
 * on first use. A different price is a different PayPal plan.
 */
export async function ensureBillingPlan(input: {
  providerPlanId: string;
  name: string;
  providerName: string | null;
  unitPriceCents: number;
  interval: { unit: "WEEK" | "MONTH" | "YEAR"; count: number };
}): Promise<string> {
  const { env } = paypalConfig();
  const { data: existing } = await db()
    .from("paypal_billing_plans")
    .select("paypal_plan_id")
    .eq("provider_plan_id", input.providerPlanId)
    .eq("env", env)
    .eq("unit_price_cents", input.unitPriceCents)
    .eq("currency", "USD")
    .eq("interval_unit", input.interval.unit)
    .eq("interval_count", input.interval.count)
    .maybeSingle();
  if (existing?.paypal_plan_id) return existing.paypal_plan_id as string;

  const label = [input.providerName, input.name].filter(Boolean).join(" · ").slice(0, 127);
  const product = await paypal<{ id: string }>("/v1/catalogs/products", {
    method: "POST",
    requestId: `prod-${input.providerPlanId}-${env}`,
    body: { name: label || "EverySub membership", type: "SERVICE", category: "SOFTWARE" },
  });
  const plan = await paypal<{ id: string }>("/v1/billing/plans", {
    method: "POST",
    requestId: `plan-${input.providerPlanId}-${env}-${input.unitPriceCents}-${input.interval.unit}${input.interval.count}`,
    body: {
      product_id: product.id,
      name: label || "EverySub membership",
      status: "ACTIVE",
      billing_cycles: [{
        frequency: { interval_unit: input.interval.unit, interval_count: input.interval.count },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0, // until cancelled
        pricing_scheme: { fixed_price: { value: usd(input.unitPriceCents), currency_code: "USD" } },
      }],
      quantity_supported: true,
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 2,
      },
    },
  });

  const { error } = await db().from("paypal_billing_plans").insert({
    provider_plan_id: input.providerPlanId,
    env,
    unit_price_cents: input.unitPriceCents,
    currency: "USD",
    interval_unit: input.interval.unit,
    interval_count: input.interval.count,
    paypal_product_id: product.id,
    paypal_plan_id: plan.id,
  });
  if (error) {
    // Lost a race to a concurrent checkout: use the winner's plan.
    const { data: winner } = await db().from("paypal_billing_plans").select("paypal_plan_id")
      .eq("provider_plan_id", input.providerPlanId).eq("env", env).eq("unit_price_cents", input.unitPriceCents)
      .eq("interval_unit", input.interval.unit).eq("interval_count", input.interval.count).maybeSingle();
    if (winner?.paypal_plan_id) return winner.paypal_plan_id as string;
    throw new HttpError(503, "Could not save the PayPal plan.");
  }
  return plan.id;
}

/**
 * Verify a webhook with PayPal itself. The body is only trusted after this —
 * and even then every decision re-reads the subscription from PayPal.
 */
export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
  const { webhookId } = paypalConfig();
  if (!webhookId) return false;
  const res = await paypal<{ verification_status?: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    },
  }).catch(() => ({ verification_status: "FAILURE" }));
  return res.verification_status === "SUCCESS";
}

/** A stable uuid from any string (subscription_renewals.idempotency_key is uuid). */
export async function uuidFrom(text: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
