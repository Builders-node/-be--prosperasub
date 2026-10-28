import { Hono } from "hono";
import { requireAccount, type AuthUser } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { ensureBillingPlan, intervalFor, paypal, paypalConfig, uuidFrom, verifyWebhook } from "../lib/paypal.ts";

/**
 * PayPal auto-renew for every service that sells a subscription.
 *
 * Three tables hold subscriptions and each says "period", "price" and "paid"
 * in its own columns — provider_subscriptions (Beach Club + universal plans),
 * food_subscriptions (N weeks), cleaning_subscriptions (N months). Each is a
 * `Kind` below; the flow is one:
 *
 *   POST /payments/paypal/subscriptions            → PayPal subscription for the reserved row
 *   POST /payments/paypal/subscriptions/:id/activate → after approval: first term paid
 *   POST /webhooks/paypal                          → every later charge renews the row
 *   POST /account/subscriptions/:id/auto-renew/cancel
 *
 * One PayPal billing cycle = the term the customer bought (N weeks / N
 * months / N periods). A renewal is recorded like a manual one: a
 * subscription_renewals row keyed on the PayPal sale + the row's dates moved
 * one term, so earnings, payouts and analytics read it unchanged.
 */
export const paypalSubscriptions = new Hono();

const TZ = "America/Tegucigalpa";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const nextStartAfter = (prevEnd: string) => { const n = addDays(prevEnd, 1); return n > today() ? n : today(); };
const cents = (v: string | number | undefined) => Math.round(Number(v ?? 0) * 100);
const ymd = (v: unknown) => (v ? String(v).slice(0, 10) : null);

type Row = Record<string, any>;
type Interval = { unit: "WEEK" | "MONTH" | "YEAR"; count: number };

interface Term {
  providerPlanId: string;
  planName: string;
  providerName: string | null;
  /** What one cycle costs before the PayPal fee, per unit, and how many units. */
  unitBaseCents: number;
  quantity: number;
  interval: Interval;
}

interface Kind {
  key: "provider" | "food" | "cleaning";
  table: string;
  cols: string;
  paid: (r: Row) => boolean;
  /** The checkout's service names this kind answers for. */
  services: string[];
  term: (r: Row) => Promise<Term>;
  firstPaidPatch: Record<string, unknown>;
  /** The renewal: subscription_renewals.service, and the row's new dates. */
  renewal: (r: Row) => { service: string; previousEnd: string; newStart: string; newEnd: string; patch: Record<string, unknown> };
  baseOfRenewal: (r: Row) => number;
}

async function planByIdOrSource(id: string | null) {
  if (!id) return null;
  // Cleaning package ids are text ("pkg-…"); comparing one to the uuid id
  // column would fail the whole query, so only a uuid is tried as an id.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const { data } = await db().from("provider_plans")
    .select("id,name,price_cents,period,pricing_mode,provider_id,status")
    .or(isUuid ? `id.eq.${id},source_plan_id.eq.${id}` : `source_plan_id.eq.${id}`).limit(1).maybeSingle();
  return data as Row | null;
}
async function providerName(id: string | null) {
  if (!id) return null;
  const { data } = await db().from("providers").select("name").eq("id", id).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}
function capInterval(i: Interval, n: number): Interval {
  const count = i.count * Math.max(1, n);
  const max = i.unit === "WEEK" ? 52 : i.unit === "MONTH" ? 12 : 1;
  if (count > max) throw badRequest("That term is too long to renew automatically — choose a shorter one, or pay once.");
  return { unit: i.unit, count };
}

const KINDS: Kind[] = [
  {
    key: "provider",
    table: "provider_subscriptions",
    cols: "id,user_id,plan_id,provider_id,status,payment_status,price_cents,periods_paid,start_date,end_date,source_service_key,promo_code,credit_applied_cents,metadata,paypal_subscription_id,auto_renew",
    services: ["beach", "universal"],
    paid: (r) => r.payment_status === "paid",
    term: async (r) => {
      if (!(r.source_service_key === "beach" || r.source_service_key === null)) throw badRequest("This subscription cannot renew automatically.");
      const plan = await planByIdOrSource(r.plan_id);
      if (!plan) throw notFound("Plan not found.");
      const base = intervalFor((r.metadata?.period as string | undefined) ?? plan.period);
      if (!base) throw badRequest("This plan is a one-off purchase and cannot renew automatically.");
      const periods = Math.max(1, Number(r.periods_paid) || 1);
      const quantity = plan.pricing_mode === "per_person" ? Math.max(1, Number(r.metadata?.people ?? 1)) : 1;
      const unit = Number(plan.price_cents) * periods;
      if (Number(r.price_cents) !== unit * quantity) throw badRequest("The plan's price changed — please reload the checkout.");
      return { providerPlanId: plan.id, planName: plan.name, providerName: await providerName(r.provider_id), unitBaseCents: unit, quantity, interval: capInterval(base, periods) };
    },
    firstPaidPatch: { status: "active", payment_status: "paid" },
    renewal: (r) => {
      const period = String(r.metadata?.period ?? "monthly").toLowerCase();
      const n = Math.max(1, Number(r.periods_paid) || 1);
      const adv = (d: string) => period === "weekly" ? addDays(d, 7 * n) : period === "quarterly" ? addMonths(d, 3 * n) : period === "yearly" ? addMonths(d, 12 * n) : addMonths(d, n);
      const previousEnd = ymd(r.end_date) ?? adv(ymd(r.start_date) ?? today());
      const newStart = nextStartAfter(previousEnd);
      const newEnd = adv(newStart);
      return {
        service: r.source_service_key === "beach" ? "beach" : "plan", previousEnd, newStart, newEnd,
        patch: { start_date: newStart, end_date: newEnd, status: "active", payment_status: "paid" },
      };
    },
    baseOfRenewal: (r) => Number(r.price_cents) || 0,
  },
  {
    key: "food",
    table: "food_subscriptions",
    cols: "id,user_id,meal_plan_id,provider_id,status,payment_status,weekly_price_cents,commitment_weeks,periods_paid,started_at,end_date,promo_code,credit_applied_cents,paypal_subscription_id,auto_renew",
    services: ["food"],
    paid: (r) => r.payment_status === "paid",
    term: async (r) => {
      const plan = await planByIdOrSource(r.meal_plan_id);
      if (!plan) throw notFound("Plan not found.");
      if (Number(r.weekly_price_cents) !== Number(plan.price_cents)) throw badRequest("The plan's price changed — please reload the checkout.");
      const weeks = Math.max(1, Number(r.commitment_weeks) || 1);
      return {
        providerPlanId: plan.id, planName: plan.name, providerName: await providerName(plan.provider_id),
        unitBaseCents: Number(r.weekly_price_cents) * weeks, quantity: 1, interval: capInterval({ unit: "WEEK", count: 1 }, weeks),
      };
    },
    firstPaidPatch: { status: "active", payment_status: "paid" },
    renewal: (r) => {
      // Same arithmetic as POST /account/food/subscriptions/:id/renew.
      const weeks = Math.max(1, Number(r.commitment_weeks) || 1);
      const previousEnd = ymd(r.end_date) ?? addDays(ymd(r.started_at) ?? today(), weeks * 7);
      const newStart = nextStartAfter(previousEnd);
      const newEnd = addDays(newStart, weeks * 7);
      return {
        service: "food", previousEnd, newStart, newEnd,
        patch: { started_at: newStart, end_date: newEnd, status: "active", payment_status: "paid", paused_at: null, periods_paid: (Number(r.periods_paid) || 1) + 1 },
      };
    },
    baseOfRenewal: (r) => (Number(r.weekly_price_cents) || 0) * Math.max(1, Number(r.commitment_weeks) || 1),
  },
  {
    key: "cleaning",
    table: "cleaning_subscriptions",
    cols: "id,user_id,package_id,subscription_status,payment_status,monthly_price_cents,billing_period_months,total_price_cents,start_date,end_date,promo_code,credit_applied_cents,paypal_subscription_id,auto_renew",
    services: ["cleaning"],
    paid: (r) => r.payment_status === "paid",
    term: async (r) => {
      const plan = await planByIdOrSource(r.package_id);
      if (!plan) throw notFound("Plan not found.");
      if (Number(r.monthly_price_cents) !== Number(plan.price_cents)) throw badRequest("The plan's price changed — please reload the checkout.");
      const months = Math.max(1, Number(r.billing_period_months) || 1);
      return {
        providerPlanId: plan.id, planName: plan.name, providerName: await providerName(plan.provider_id),
        unitBaseCents: Number(r.monthly_price_cents) * months, quantity: 1, interval: capInterval({ unit: "MONTH", count: 1 }, months),
      };
    },
    firstPaidPatch: { subscription_status: "active", is_active: true, payment_status: "paid" },
    renewal: (r) => {
      // Same arithmetic as POST /account/cleaning/subscriptions/:id/renew.
      const months = Math.max(1, Number(r.billing_period_months) || 1);
      const previousEnd = ymd(r.end_date) ?? addMonths(ymd(r.start_date) ?? today(), months);
      const newStart = nextStartAfter(previousEnd);
      const newEnd = addMonths(newStart, months);
      return {
        service: "cleaning", previousEnd, newStart, newEnd,
        patch: {
          start_date: newStart, end_date: newEnd, service_start_date: newStart, service_end_date: newEnd, paid_until: newEnd,
          subscription_status: "active", is_active: true, payment_status: "paid",
        },
      };
    },
    baseOfRenewal: (r) => (Number(r.monthly_price_cents) || 0) * Math.max(1, Number(r.billing_period_months) || 1),
  },
];

const kindForService = (service: string | undefined) =>
  KINDS.find((k) => k.services.includes(String(service ?? "universal"))) ?? KINDS[0];

async function load(kind: Kind, filter: (q: any) => any): Promise<Row | null> {
  const { data, error } = await filter(db().from(kind.table).select(kind.cols)).maybeSingle();
  if (error) throw new HttpError(503, "Could not read the subscription.");
  return data as Row | null;
}

/** The row behind a PayPal subscription id, whichever table it is in. */
async function findByPayPalId(id: string): Promise<{ kind: Kind; row: Row } | null> {
  for (const kind of KINDS) {
    const row = await load(kind, (q) => q.eq("paypal_subscription_id", id));
    if (row) return { kind, row };
  }
  return null;
}

/** Legacy tables may hold a Google login's `google-…` id; the universal one holds users.id. */
const owns = (row: Row, user: AuthUser) => [user.id, user.sub].includes(String(row.user_id ?? ""));

async function surchargePct(): Promise<number> {
  const { data } = await db().from("payment_method_settings").select("surcharge_percent,enabled").eq("method", "paypal").maybeSingle();
  if (data && data.enabled === false) throw new HttpError(409, "PayPal is switched off.");
  return Number(data?.surcharge_percent ?? 0) || 0;
}

async function markFirstPaid(kind: Kind, row: Row, subscriptionId: string) {
  if (kind.paid(row)) return;
  const { error } = await db().from(kind.table).update({
    ...kind.firstPaidPatch,
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
  const body = await c.req.json().catch(() => ({})) as { row_id?: string; service?: string };
  if (!body.row_id) throw badRequest("row_id is required");
  const kind = kindForService(body.service);
  const row = await load(kind, (q) => q.eq("id", body.row_id));
  if (!row) throw notFound("Subscription not found.");
  if (!owns(row, user)) throw forbidden("Not your subscription.");
  if (kind.paid(row)) throw new HttpError(409, "Already paid.");
  if (row.promo_code || (Number(row.credit_applied_cents) || 0) > 0) {
    throw badRequest("Automatic renewal cannot be combined with a promo code or credit.");
  }

  const t = await kind.term(row);
  const pct = await surchargePct();
  const unitCharged = Math.round(t.unitBaseCents * (1 + pct / 100));
  const planId = await ensureBillingPlan({
    providerPlanId: t.providerPlanId, name: t.planName, providerName: t.providerName,
    unitPriceCents: unitCharged, interval: t.interval,
  });
  const sub = await paypal<{ id: string }>("/v1/billing/subscriptions", {
    method: "POST",
    body: {
      plan_id: planId,
      quantity: String(t.quantity),
      custom_id: `${kind.key}:${row.id}`,
      application_context: { brand_name: "EverySub", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW" },
    },
  });
  await db().from(kind.table).update({ paypal_subscription_id: sub.id, payment_method: "paypal", updated_at: new Date().toISOString() }).eq("id", row.id);
  return c.json({ id: sub.id, amount_cents: unitCharged * t.quantity }, 201);
});

/** custom_id is "<kind>:<row id>"; rows created before kinds existed carry the bare id. */
const customMatches = (custom: unknown, kind: Kind, row: Row) =>
  custom === `${kind.key}:${row.id}` || (kind.key === "provider" && custom === row.id);

// ── After the customer approves: is the first term paid? ─────────────────────
paypalSubscriptions.post("/payments/paypal/subscriptions/:id/activate", async (c) => {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  const found = await findByPayPalId(id);
  if (!found) throw notFound("Subscription not found.");
  const { kind, row } = found;
  if (!owns(row, user)) throw forbidden("Not your subscription.");

  const sub = await paypal<any>(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  if (!customMatches(sub.custom_id, kind, row)) throw forbidden("Subscription does not match.");
  const status = String(sub.status);
  const lastPaid = cents(sub.billing_info?.last_payment?.amount?.value);
  const paid = status === "ACTIVE" && lastPaid > 0;
  if (paid) await markFirstPaid(kind, row, id);
  // Not yet: PayPal sometimes settles the first charge seconds after approval.
  // The browser polls; the webhook settles it if the tab closes.
  return c.json({ paid: paid || kind.paid(row), status });
});

// ── Customer turns auto-renew off (access runs to end_date) ───────────────────
paypalSubscriptions.post("/account/subscriptions/:id/auto-renew/cancel", async (c) => {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  let found: { kind: Kind; row: Row } | null = null;
  for (const kind of KINDS) {
    const row = await load(kind, (q) => q.eq("id", id));
    if (row) { found = { kind, row }; break; }
  }
  if (!found) throw notFound("Subscription not found.");
  const { kind, row } = found;
  if (!owns(row, user)) throw forbidden("Not your subscription.");
  if (row.paypal_subscription_id && row.auto_renew) {
    await paypal(`/v1/billing/subscriptions/${encodeURIComponent(row.paypal_subscription_id)}/cancel`, {
      method: "POST", body: { reason: "Cancelled by the customer on EverySub" },
    });
  }
  await db().from(kind.table).update({ auto_renew: false, updated_at: new Date().toISOString() }).eq("id", row.id);
  return c.json({ ok: true, auto_renew: false, end_date: row.end_date ?? null }, 201);
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
      // Re-activated after a suspend. The first activation is settled by the sale.
      const found = await findByPayPalId(String(resource.id));
      if (found && found.kind.paid(found.row)) {
        await db().from(found.kind.table).update({ auto_renew: true, updated_at: new Date().toISOString() }).eq("id", found.row.id);
      }
    } else if (["BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED"].includes(type)) {
      const found = await findByPayPalId(String(resource.id));
      if (found) await db().from(found.kind.table).update({ auto_renew: false, updated_at: new Date().toISOString() }).eq("id", found.row.id);
    }
  } catch (e) {
    // Poison-message rule: log and acknowledge; only a transient DB error is retried.
    if (e instanceof HttpError && e.status >= 500) throw e;
    console.error(`[paypal-webhook] ${type} ${event.id}:`, e);
  }
  return c.json({ ok: true });
});

async function onSaleCompleted(subscriptionId: string, saleId: string, amountCents: number) {
  const found = await findByPayPalId(subscriptionId);
  if (!found) { console.warn(`[paypal-webhook] no row for ${subscriptionId}`); return; }
  const { kind, row } = found;

  // Re-read from PayPal: the event says a sale happened, PayPal says whose.
  const sub = await paypal<any>(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (!customMatches(sub.custom_id, kind, row)) { console.warn(`[paypal-webhook] custom_id mismatch for ${subscriptionId}`); return; }

  if (!kind.paid(row)) {
    await markFirstPaid(kind, row, subscriptionId);
    return;
  }

  const r = kind.renewal(row);
  const base = kind.baseOfRenewal(row);
  const { data: inserted, error } = await db().from("subscription_renewals").upsert({
    service: r.service,
    subscription_id: row.id,
    previous_end: r.previousEnd,
    new_start: r.newStart,
    new_end: r.newEnd,
    amount_cents: base,
    surcharge_cents: Math.max(0, amountCents - base),
    payment_method: "paypal",
    payment_reference: saleId,
    idempotency_key: await uuidFrom(`paypal-sale:${saleId}`),
    renewed_by_user: /^[0-9a-f-]{36}$/i.test(String(row.user_id)) ? row.user_id : null,
  }, { onConflict: "subscription_id,idempotency_key", ignoreDuplicates: true }).select("id");
  if (error) throw new HttpError(503, `Could not record the renewal: ${error.message}`);
  if (!inserted?.length) return; // this sale was already applied

  const { error: upErr } = await db().from(kind.table)
    .update({ ...r.patch, auto_renew: true, updated_at: new Date().toISOString() }).eq("id", row.id);
  if (upErr) throw new HttpError(503, `Could not extend the subscription: ${upErr.message}`);
}
