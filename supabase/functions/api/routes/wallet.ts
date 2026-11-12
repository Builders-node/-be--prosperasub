import { Hono, type Context } from "hono";
import { requireAccount, type AuthUser } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";
import { sendMail, escapeHtml } from "../lib/mail.ts";
import { uuidFrom } from "../lib/paypal.ts";
import { referenceAlreadyUsed, verifyPayment } from "../lib/paymentCheck.ts";
import { KINDS, addDays, load, owns, planByIdOrSource, today, type Kind, type Row } from "./paypal-subscriptions.ts";

/**
 * The wallet — a prepaid balance, and automatic renewal from it (migration
 * 20261122120000_wallet_auto_renew). For customers who pay in Bitcoin, where
 * nothing can pull the next payment the way PayPal does.
 *
 *   GET  /account/wallet                         → balance, history, renewable subscriptions
 *   POST /account/wallet/topups                  {amountCents, method, reference}  — an invoice exists
 *   POST /account/wallet/topups/confirm          {reference}                      — it was paid: credit once
 *   POST /account/subscriptions/:id/auto-renew   {enabled}                        — renew from the balance
 *   POST /cron/wallet-renewals                                                     — the daily run (pg_cron)
 *
 * A top-up is an ordinary invoice (the checkout's own rails); the server
 * re-verifies it with Blink / PayPal for the amount plus that method's fee and
 * credits the ledger keyed on the payment reference — a second confirm, a
 * second tab, the cron re-check: all the same one credit.
 *
 * A renewal from the balance is recorded EXACTLY like a PayPal one
 * (routes/paypal-subscriptions.ts): wallet_spend() debits atomically, then a
 * subscription_renewals row + the subscription's dates moved one term. Every
 * step is keyed on "<table>:<row>:<new start>", so a run that dies half-way is
 * finished by the next one and never charges twice.
 */
export const wallet = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^[0-9a-zA-Z_:.-]{6,200}$/;
const METHODS = ["lightning", "onchain", "paypal"] as const;
type Method = (typeof METHODS)[number];
const MIN_CENTS = 500;
/** What the top-up invoice is called — the marker the server looks for. Same string in lib/wallet.ts. */
const TOPUP_SERVICE_NAME = "EverySub balance top-up";
const MAX_CENTS = 200_000;

const missing = (msg: string) => /wallet_|does not exist|wallet_spend/i.test(msg);

/** The fee a method adds on top (payment_method_settings) — part of the invoice, not of the balance. */
async function surchargePct(method: Method): Promise<number> {
  const { data } = await db().from("payment_method_settings").select("surcharge_percent,enabled").eq("method", method).maybeSingle();
  if (data && data.enabled === false) throw new HttpError(409, "That way to pay is switched off.");
  return Number(data?.surcharge_percent ?? 0) || 0;
}

export async function balanceOf(userId: string): Promise<number> {
  const { data, error } = await db().from("wallet_ledger").select("amount_cents").eq("user_id", userId).limit(10_000);
  if (error) {
    if (missing(error.message)) throw new HttpError(503, "The wallet is not switched on yet.");
    throw new HttpError(503, "Could not read the balance.");
  }
  return (data ?? []).reduce((s, r) => s + Number(r.amount_cents || 0), 0);
}

/**
 * A top-up must be a payment raised AS a top-up: its checkout session says so
 * (context "wallet_topup", written when the invoice was made), and no order —
 * paid or still pending — carries the same reference. Otherwise somebody's
 * order payment could be claimed as a balance.
 */
async function isTopupPayment(reference: string, method: string): Promise<boolean> {
  // PayPal's order sessions carry no context; a capture id is known only to
  // the payer, and the order check below still applies.
  if (method !== "paypal") {
    // Lightning records `context`; on-chain records only the service name —
    // the browser sends both (TOPUP_SERVICE_NAME).
    const { data: s } = await db().from("payment_checkout_sessions")
      .select("context, service_name").eq("provider_payment_id", reference).order("created_at", { ascending: false }).limit(1);
    if (!s?.length || !(s[0].context === "wallet_topup" || s[0].service_name === TOPUP_SERVICE_NAME)) return false;
  }
  for (const t of ["rental_bookings", "provider_subscriptions", "food_subscriptions", "cleaning_subscriptions"]) {
    const { data } = await db().from(t).select("id").eq("payment_reference", reference).limit(1);
    if (data?.length) return false;
  }
  return true;
}

/** Verify a pending top-up and credit it — idempotent on the reference. */
async function settleTopup(topup: Row): Promise<"paid" | "pending"> {
  if (topup.status === "paid") return "paid";
  if (!(await isTopupPayment(String(topup.payment_reference), String(topup.method)))) return "pending";
  const pct = await surchargePct(topup.method as Method).catch(() => 0);
  const expected = Math.round(Number(topup.amount_cents) * (1 + pct / 100));
  const v = await verifyPayment(String(topup.method), String(topup.payment_reference), expected);
  if (!v.ok) return "pending";
  if (await referenceAlreadyUsed(String(topup.payment_reference), { table: "wallet_topups", id: String(topup.id) })) {
    // The same payment already settled an order — it cannot also be a balance.
    return "pending";
  }
  const { error } = await db().from("wallet_ledger").insert({
    user_id: topup.user_id, amount_cents: Number(topup.amount_cents), kind: "topup",
    reference: String(topup.payment_reference), note: `Top-up · ${topup.method}`,
  });
  if (error && !/duplicate|unique/i.test(error.message)) throw new HttpError(503, "Could not credit the balance.");
  await db().from("wallet_topups").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", topup.id);
  return "paid";
}

// ── What the customer sees ────────────────────────────────────────────────────

/** The subscriptions of this person that could renew from the balance. */
async function renewable(user: AuthUser) {
  const out: Array<Record<string, unknown>> = [];
  for (const kind of KINDS) {
    const { data } = await db().from(kind.table).select(kind.cols)
      .in("user_id", [user.id, user.sub].filter(Boolean)).eq("payment_status", "paid").limit(100);
    for (const row of (data ?? []) as Row[]) {
      if (!running(kind, row)) continue;
      if (kind.key === "provider" && !(row.source_service_key === "beach" || row.source_service_key === null)) continue;
      const plan = await planByIdOrSource(kind.key === "food" ? row.meal_plan_id : kind.key === "cleaning" ? row.package_id : row.plan_id);
      if (isOneTime(row, plan)) continue;
      out.push({
        id: row.id,
        planName: plan?.name ?? "Subscription",
        endDate: row.end_date ?? null,
        priceCents: kind.baseOfRenewal(row),
        autoRenew: !!row.auto_renew,
        viaPayPal: !!row.paypal_subscription_id && !!row.auto_renew,
      });
    }
  }
  return out.sort((a, b) => String(a.endDate ?? "").localeCompare(String(b.endDate ?? "")));
}

const statusOf = (kind: Kind, r: Row) => String(kind.key === "cleaning" ? r.subscription_status : r.status ?? "");
const running = (kind: Kind, r: Row) => ["active", "expiring", "expired"].includes(statusOf(kind, r)) && !r.cancelled_at;
const isOneTime = (r: Row, plan: Row | null) =>
  String(r.metadata?.period ?? plan?.period ?? "").toLowerCase() === "one_time";

wallet.get("/account/wallet", async (c) => {
  const user = await requireAccount(c);
  // A tab that closed after paying: settle what is still pending, newest first.
  const { data: pending } = await db().from("wallet_topups").select("*")
    .eq("user_id", user.id).eq("status", "pending").order("created_at", { ascending: false }).limit(5);
  for (const t of pending ?? []) await settleTopup(t).catch(() => undefined);

  const balanceCents = await balanceOf(user.id);
  const { data: entries } = await db().from("wallet_ledger")
    .select("id, amount_cents, kind, note, created_at").eq("user_id", user.id)
    .order("created_at", { ascending: false }).limit(30);
  return c.json({ balanceCents, entries: entries ?? [], subscriptions: await renewable(user), minTopupCents: MIN_CENTS });
});

wallet.post("/account/wallet/topups", async (c) => {
  const user = await requireAccount(c);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const amount = Math.round(Number(b.amountCents));
  const method = String(b.method ?? "") as Method;
  const reference = String(b.reference ?? "");
  if (!Number.isFinite(amount) || amount < MIN_CENTS || amount > MAX_CENTS) throw badRequest(`Top up between $${MIN_CENTS / 100} and $${MAX_CENTS / 100}.`);
  if (!METHODS.includes(method)) throw badRequest("Unknown way to pay.");
  if (!REF_RE.test(reference)) throw badRequest("Bad payment reference.");
  await surchargePct(method);
  if (!(await isTopupPayment(reference, method))) throw badRequest("That payment was not raised as a top-up.");
  const { error } = await db().from("wallet_topups").insert({ user_id: user.id, amount_cents: amount, method, payment_reference: reference });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new HttpError(409, "That payment is already a top-up.");
    if (missing(error.message)) throw new HttpError(503, "The wallet is not switched on yet.");
    throw new HttpError(503, "Could not start the top-up.");
  }
  return c.json({ ok: true }, 201);
});

wallet.post("/account/wallet/topups/confirm", async (c) => {
  const user = await requireAccount(c);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const reference = String(b.reference ?? "");
  if (!REF_RE.test(reference)) throw badRequest("Bad payment reference.");
  const { data: topup } = await db().from("wallet_topups").select("*").eq("payment_reference", reference).maybeSingle();
  if (!topup) throw notFound("Top-up not found.");
  if (String(topup.user_id) !== String(user.id)) throw forbidden("Not your top-up.");
  const status = await settleTopup(topup);
  return c.json({ status, balanceCents: await balanceOf(user.id) });
});

wallet.post("/account/subscriptions/:id/auto-renew", async (c) => {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const enabled = !!b.enabled;
  let found: { kind: Kind; row: Row } | null = null;
  for (const kind of KINDS) {
    const row = await load(kind, (q) => q.eq("id", id));
    if (row) { found = { kind, row }; break; }
  }
  if (!found) throw notFound("Subscription not found.");
  const { kind, row } = found;
  if (!owns(row, user)) throw forbidden("Not your subscription.");
  if (row.paypal_subscription_id && row.auto_renew) {
    throw new HttpError(409, "This one already renews through PayPal — turn that off first.");
  }
  if (enabled) {
    if (!kind.paid(row)) throw badRequest("Pay for it first — renewal starts from a paid period.");
    if (kind.key === "provider" && !(row.source_service_key === "beach" || row.source_service_key === null)) {
      throw badRequest("This subscription cannot renew automatically.");
    }
    const plan = await planByIdOrSource(kind.key === "food" ? row.meal_plan_id : kind.key === "cleaning" ? row.package_id : row.plan_id);
    if (isOneTime(row, plan)) throw badRequest("A one-off purchase does not renew.");
  }
  const { error } = await db().from(kind.table).update({ auto_renew: enabled, updated_at: new Date().toISOString() }).eq("id", row.id);
  if (error) throw new HttpError(503, "Could not change auto-renew.");
  return c.json({ ok: true, autoRenew: enabled });
});

// ── The daily run ────────────────────────────────────────────────────────────

async function requireCronKey(c: Context) {
  const key = c.req.header("x-cron-key");
  if (!key) throw unauthorized("Cron key required");
  const { data, error } = await db().rpc("cron_key_matches", { p_name: "wallet_renewals_key", p_key: key });
  if (error || data !== true) throw unauthorized("Bad cron key");
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

wallet.post("/cron/wallet-renewals", async (c) => {
  await requireCronKey(c);
  const horizon = addDays(today(), 1); // ends tomorrow or earlier
  const oldest = addDays(today(), -14); // a lapse older than this is a choice, not a missed charge
  const result = { renewed: 0, short: 0, skipped: 0, failed: 0 };

  for (const kind of KINDS) {
    const { data, error } = await db().from(kind.table).select(kind.cols)
      .eq("auto_renew", true).is("paypal_subscription_id", null).eq("payment_status", "paid")
      .lte("end_date", horizon).gte("end_date", oldest).limit(500);
    if (error) { result.failed++; continue; }

    for (const row of (data ?? []) as Row[]) {
      try {
        if (!running(kind, row) || !UUID_RE.test(String(row.user_id ?? ""))) { result.skipped++; continue; }
        if (kind.key === "provider" && !(row.source_service_key === "beach" || row.source_service_key === null)) { result.skipped++; continue; }
        const plan = await planByIdOrSource(kind.key === "food" ? row.meal_plan_id : kind.key === "cleaning" ? row.package_id : row.plan_id);
        if (isOneTime(row, plan)) { result.skipped++; continue; }

        const r = kind.renewal(row);
        const price = kind.baseOfRenewal(row);
        if (!(price > 0)) { result.skipped++; continue; }
        const reference = `${kind.table}:${row.id}:${r.newStart}`;

        const { data: after, error: spendErr } = await db().rpc("wallet_spend", {
          p_user_id: String(row.user_id), p_amount_cents: price, p_reference: reference,
          p_note: `Renewal · ${plan?.name ?? "subscription"}`,
        });
        if (spendErr) throw spendErr;
        if (after === null) {
          result.short++;
          await tellShort(kind, row, plan?.name ?? "your subscription", price, r.previousEnd);
          continue;
        }

        const { error: renErr } = await db().from("subscription_renewals").upsert({
          service: r.service,
          subscription_id: row.id,
          previous_end: r.previousEnd,
          new_start: r.newStart,
          new_end: r.newEnd,
          amount_cents: price,
          surcharge_cents: 0,
          payment_method: "balance",
          payment_reference: reference,
          idempotency_key: await uuidFrom(`wallet:${reference}`),
          renewed_by_user: row.user_id,
        }, { onConflict: "subscription_id,idempotency_key", ignoreDuplicates: true });
        if (renErr) throw renErr;

        const { error: upErr } = await db().from(kind.table)
          .update({ ...r.patch, auto_renew: true, updated_at: new Date().toISOString() }).eq("id", row.id);
        if (upErr) throw upErr;

        result.renewed++;
        await notifyUser({
          recipientUserId: String(row.user_id), category: "billing", type: "wallet_renewed",
          title: `${plan?.name ?? "Your subscription"} renewed`,
          body: `${usd(price)} from your balance — now runs until ${r.newEnd}.`,
          relatedEntityType: kind.table, relatedEntityId: String(row.id), actionUrl: "/account?section=wallet",
        }).catch(() => undefined);
      } catch (e) {
        result.failed++;
        console.error(`[wallet-renewals] ${kind.table} ${row.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return c.json(result);
});

/** Not enough on the balance: say so once per period, with the amount to top up. */
async function tellShort(kind: Kind, row: Row, planName: string, priceCents: number, periodEnd: string) {
  const { error } = await db().from("wallet_renewal_notices")
    .insert({ subscription_key: `${kind.table}:${row.id}`, period_end: periodEnd });
  if (error) return; // already told for this period (or the table is missing)
  const balance = await balanceOf(String(row.user_id)).catch(() => 0);
  const need = Math.max(0, priceCents - balance);
  const body = `Your ${planName} ends on ${periodEnd}. It renews automatically from your balance, which is ${usd(balance)} — top up ${usd(need)} to keep it running.`;
  await notifyUser({
    recipientUserId: String(row.user_id), category: "billing", type: "wallet_short",
    title: "Top up to renew", body, relatedEntityType: kind.table, relatedEntityId: String(row.id),
    actionUrl: "/account?section=wallet",
  }).catch(() => undefined);
  const { data: u } = await db().from("users").select("email").eq("id", row.user_id).maybeSingle();
  if (u?.email) {
    await sendMail({
      to: u.email,
      subject: `Top up ${usd(need)} to renew ${planName}`,
      text: `${body}\n\nTop up: https://everysub.net/account?section=wallet`,
      html: `<p>${escapeHtml(body)}</p><p><a href="https://everysub.net/account?section=wallet">Top up on EverySub</a></p>`,
    }).catch(() => undefined);
  }
}
