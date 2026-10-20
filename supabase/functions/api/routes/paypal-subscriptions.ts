import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { ensureBillingPlan, intervalFor, paypal, paypalConfig, uuidFrom, verifyWebhook } from "../lib/paypal.ts";

/**
 * PayPal auto-renew for provider_subscriptions (Beach Club and universal plans).
 *
 * Checkout reserves the row as today, then:
 *   POST /payments/paypal/subscriptions            → PayPal subscription for that row
 *   POST /payments/paypal/subscriptions/:id/activate → after approval: first period paid
 *   POST /webhooks/paypal                          → every later charge renews the row
 *   POST /account/subscriptions/:id/auto-renew/cancel
 *
 * A renewal is recorded exactly like a manual one (account-renewals.service):
 * one subscription_renewals row + dates moved one period, so earnings,
 * payouts and analytics read it the same way. The first period is the row's
 * own price; renewals never touch price_cents.
 */
export const paypalSubscriptions = new Hono();

const TZ = "America/Tegucigalpa";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const advance = (d: string, period: string) => {
  switch (String(period).toLowerCase()) {
    case "weekly": return addDays(d, 7);
    case "quarterly": return addMonths(d, 3);
    case "yearly": return addMonths(d, 12);
    default: return addMonths(d, 1);
  }
};
const continuousNextStart = (prevEnd: string) => {
  const next = addDays(prevEnd, 1);
  return next > today() ? next : today();
};
const cents = (v: string | number | undefined) => Math.round(Number(v ?? 0) * 100);

type SubRow = {
  id: string; user_id: string | null; plan_id: string | null; provider_id: string | null;
  status: string; payment_status: string; price_cents: number; periods_paid: number | null;
  start_date: string | null; end_date: string | null; source_service_key: string | null;
  promo_code: string | null; credit_applied_cents: number | null; metadata: Record<string, unknown> | null;
  paypal_subscription_id: string | null; auto_renew: boolean;
};
const SUB_COLS = "id,user_id,plan_id,provider_id,status,payment_status,price_cents,periods_paid,start_date,end_date,source_service_key,promo_code,credit_applied_cents,metadata,paypal_subscription_id,auto_renew";

async function loadRow(filter: (q: any) => any): Promise<SubRow | null> {
  const { data, error } = await filter(db().from("provider_subscriptions").select(SUB_COLS)).maybeSingle();
  if (error) throw new HttpError(503, "Could not read the subscription.");
  return data as SubRow | null;
}

/** Only beach memberships and universal plans live in provider_subscriptions for real. */
const renewable = (r: SubRow) => r.source_service_key === "beach" || r.source_service_key === null;

async function surchargePct(): Promise<number> {
  const { data } = await db().from("payment_method_settings").select("surcharge_percent,enabled").eq("method", "paypal").maybeSingle();
  if (data && data.enabled === false) throw new HttpError(409, "PayPal is switched off.");
  return Number(data?.surcharge_percent ?? 0) || 0;
}

/** What one period costs at PayPal, per unit, and how many units. */
async function pricing(row: SubRow) {
  const { data: plan } = await db().from("provider_plans")
    .select("id,name,price_cents,period,pricing_mode,status").eq("id", row.plan_id ?? "").maybeSingle();
  if (!plan) throw notFound("Plan not found.");
  const interval = intervalFor((row.metadata?.period as string | undefined) ?? plan.period);
  if (!interval) throw badRequest("This plan is a one-off purchase and cannot renew automatically.");
  const perPerson = plan.pricing_mode === "per_person";
  const quantity = perPerson ? Math.max(1, Number(row.metadata?.people ?? 1)) : 1;
  const baseUnit = Number(plan.price_cents);
  // The first period must be what the row says was bought — one period of
  // this plan at today's price. Anything else (several periods, a promo, a
  // credit, a stale price) is a checkout that cannot become a subscription.
  if ((row.periods_paid ?? 1) !== 1) throw badRequest("Automatic renewal is for one period at a time.");
  if (row.promo_code || (row.credit_applied_cents ?? 0) > 0) throw badRequest("Automatic renewal cannot be combined with a promo code or credit.");
  if (Number(row.price_cents) !== baseUnit * quantity) throw badRequest("The plan's price changed — please reload the checkout.");
  const pct = await surchargePct();
  const unitCharged = Math.round(baseUnit * (1 + pct / 100));
  const { data: provider } = await db().from("providers").select("name").eq("id", row.provider_id ?? "").maybeSingle();
  return {
    plan, interval, quantity, baseUnit, unitCharged,
    baseTotal: baseUnit * quantity, chargedTotal: unitCharged * quantity,
    providerName: (provider?.name as string | undefined) ?? null,
  };
}

/** First period paid: the row becomes an active, auto-renewing membership. Idempotent. */
async function markFirstPaid(row: SubRow, subscriptionId: string) {
  if (row.payment_status === "paid") return;
  const { error } = await db().from("provider_subscriptions").update({
    status: "active",
    payment_status: "paid",
    payment_method: "paypal",
    payment_reference: subscriptionId,
    paypal_subscription_id: subscriptionId,
    auto_renew: true,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).neq("payment_status", "paid");
  if (error) throw new HttpError(503, "Could not activate the subscription.");
}

// ── Config for the browser SDK ───────────────────────────────────────────────
paypalSubscriptions.get("/payments/paypal/subscription/config", (c) => {
  const cfg = paypalConfig();
  return c.json({ enabled: !!cfg.clientId && !!cfg.secret, clientId: cfg.clientId || null, env: cfg.env });
});

// ── Create the PayPal subscription for a reserved row ────────────────────────
paypalSubscriptions.post("/payments/paypal/subscriptions", async (c) => {
  const user = await requireAccount(c);
  const body = await c.req.json().catch(() => ({})) as { row_id?: string };
  if (!body.row_id) throw badRequest("row_id is required");
  const row = await loadRow((q) => q.eq("id", body.row_id));
  if (!row) throw notFound("Subscription not found.");
  if (row.user_id !== user.id) throw forbidden("Not your subscription.");
  if (!renewable(row)) throw badRequest("This subscription cannot renew automatically.");
  if (row.payment_status === "paid") throw new HttpError(409, "Already paid.");

  const p = await pricing(row);
  const planId = await ensureBillingPlan({
    providerPlanId: p.plan.id, name: p.plan.name, providerName: p.providerName,
    unitPriceCents: p.unitCharged, interval: p.interval,
  });
  const sub = await paypal<{ id: string }>("/v1/billing/subscriptions", {
    method: "POST",
    body: {
      plan_id: planId,
      quantity: String(p.quantity),
      custom_id: row.id,
      application_context: {
        brand_name: "EverySub",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
      },
    },
  });
  await db().from("provider_subscriptions").update({
    paypal_subscription_id: sub.id,
    payment_method: "paypal",
    metadata: { ...(row.metadata ?? {}), surcharge_cents: p.chargedTotal - p.baseTotal, auto_renew_requested: true },
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return c.json({ id: sub.id, amount_cents: p.chargedTotal }, 201);
});

// ── After the customer approves: is the first period paid? ───────────────────
paypalSubscriptions.post("/payments/paypal/subscriptions/:id/activate", async (c) => {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  const row = await loadRow((q) => q.eq("paypal_subscription_id", id));
  if (!row) throw notFound("Subscription not found.");
  if (row.user_id !== user.id) throw forbidden("Not your subscription.");

  const sub = await paypal<any>(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  if (sub.custom_id !== row.id) throw forbidden("Subscription does not match.");
  const status = String(sub.status);
  const lastPaid = cents(sub.billing_info?.last_payment?.amount?.value);
  const p = await pricing({ ...row, payment_status: "pending" }).catch(() => null);
  const paid = status === "ACTIVE" && lastPaid > 0 && (!p || lastPaid >= p.chargedTotal);
  if (paid) await markFirstPaid(row, id);
  // Not yet: PayPal sometimes settles the first charge a few seconds after
  // approval. The browser polls; the webhook settles it if the tab closes.
  return c.json({ paid: paid || row.payment_status === "paid", status });
});

// ── Customer turns auto-renew off (access runs to end_date) ───────────────────
paypalSubscriptions.post("/account/subscriptions/:id/auto-renew/cancel", async (c) => {
  const user = await requireAccount(c);
  const row = await loadRow((q) => q.eq("id", c.req.param("id")));
  if (!row) throw notFound("Subscription not found.");
  if (row.user_id !== user.id) throw forbidden("Not your subscription.");
  if (row.paypal_subscription_id && row.auto_renew) {
    await paypal(`/v1/billing/subscriptions/${encodeURIComponent(row.paypal_subscription_id)}/cancel`, {
      method: "POST", body: { reason: "Cancelled by the customer on EverySub" },
    });
  }
  await db().from("provider_subscriptions").update({ auto_renew: false, updated_at: new Date().toISOString() }).eq("id", row.id);
  return c.json({ ok: true, auto_renew: false, end_date: row.end_date }, 201);
});

// ── Webhook ──────────────────────────────────────────────────────────────────
paypalSubscriptions.post("/webhooks/paypal", async (c) => {
  const raw = await c.req.text();
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ ok: false }, 400); }
  if (!(await verifyWebhook(c.req.raw.headers, event))) {
    console.warn("[paypal-webhook] signature not verified", event?.id);
    return c.json({ ok: false }, 401);
  }
  const type = String(event.event_type ?? "");
  const resource = event.resource ?? {};
  try {
    if (type === "PAYMENT.SALE.COMPLETED" && resource.billing_agreement_id) {
      await onSaleCompleted(String(resource.billing_agreement_id), String(resource.id), cents(resource.amount?.total));
    } else if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      // Re-activated after a suspend (resume, or from PayPal's side). The
      // first activation is settled by the sale, not here.
      await db().from("provider_subscriptions").update({ auto_renew: true, updated_at: new Date().toISOString() })
        .eq("paypal_subscription_id", String(resource.id)).eq("payment_status", "paid");
    } else if (["BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED"].includes(type)) {
      await db().from("provider_subscriptions").update({ auto_renew: false, updated_at: new Date().toISOString() })
        .eq("paypal_subscription_id", String(resource.id));
    }
  } catch (e) {
    // Poison-message rule: log and acknowledge, never wedge PayPal's retries
    // on something a retry cannot fix. A transient DB error is rethrown.
    if (e instanceof HttpError && e.status >= 500) throw e;
    console.error(`[paypal-webhook] ${type} ${event.id}:`, e);
  }
  return c.json({ ok: true });
});

async function onSaleCompleted(subscriptionId: string, saleId: string, amountCents: number) {
  const row = await loadRow((q) => q.eq("paypal_subscription_id", subscriptionId));
  if (!row) { console.warn(`[paypal-webhook] no row for ${subscriptionId}`); return; }

  // Re-read from PayPal: the event says a sale happened, PayPal says whose.
  const sub = await paypal<any>(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (sub.custom_id !== row.id) { console.warn(`[paypal-webhook] custom_id mismatch for ${subscriptionId}`); return; }

  if (row.payment_status !== "paid") {
    await markFirstPaid(row, subscriptionId);
    return;
  }

  // A later period. Same arithmetic as AccountRenewalsService.renewPlan.
  const period = String(row.metadata?.period ?? "monthly");
  const previousEnd = (row.end_date ?? advance(row.start_date ?? today(), period)).slice(0, 10);
  const newStart = continuousNextStart(previousEnd);
  const newEnd = advance(newStart, period);
  const base = Number(row.price_cents);

  const { data: inserted, error } = await db().from("subscription_renewals").upsert({
    service: row.source_service_key === "beach" ? "beach" : "plan",
    subscription_id: row.id,
    previous_end: previousEnd,
    new_start: newStart,
    new_end: newEnd,
    amount_cents: base,
    surcharge_cents: Math.max(0, amountCents - base),
    payment_method: "paypal",
    payment_reference: saleId,
    idempotency_key: await uuidFrom(`paypal-sale:${saleId}`),
    renewed_by_user: row.user_id,
  }, { onConflict: "subscription_id,idempotency_key", ignoreDuplicates: true }).select("id");
  if (error) throw new HttpError(503, `Could not record the renewal: ${error.message}`);
  if (!inserted?.length) return; // this sale was already applied

  const { error: upErr } = await db().from("provider_subscriptions").update({
    start_date: newStart,
    end_date: newEnd,
    status: "active",
    payment_status: "paid",
    auto_renew: true,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (upErr) throw new HttpError(503, `Could not extend the subscription: ${upErr.message}`);
}
