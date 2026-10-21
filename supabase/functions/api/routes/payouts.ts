import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { summarize } from "../lib/earnings.ts";
import { classifyPayoutDestination, payoutDestinationProblem, payoutsEnabled, planWallet, sendPayout } from "../lib/blink.ts";

/**
 * Port of the provider side of ProviderPayoutsService: the payout ledger list,
 * what may be withdrawn, and the withdrawal itself. Same rules — the cap is
 * computed here, only the owner (providers.admin_user_id) or a SUPER_ADMIN may
 * move money, and the claim-then-verify write that stops two withdrawals of
 * one balance. Admin approve/send/settle stay on Nest for now.
 *
 * Changed on purpose: the money can come from the BTC wallet when USD is
 * short (lib/blink.ts), and when neither wallet can cover it the request is
 * QUEUED for an admin with a plain message, instead of failing with Blink's
 * raw "Payment amount … exceeds balance '0'".
 */
export const payouts = new Hono();

type PayoutRow = Record<string, any> & { id: string; provider_id: string; amount_cents: number; status?: string; destination?: string | null };

const isSuperAdmin = (roles: string[]) => roles.includes("SUPER_ADMIN");

async function providerOwner(providerId: string): Promise<string | null> {
  const { data, error } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (error) throw new HttpError(503, "Could not read the business.");
  if (!data) throw notFound("Provider not found.");
  return (data.admin_user_id as string | null) ?? null;
}

/** Owner, manager or admin — for reading. */
async function assertRuns(userId: string, providerId: string, isAdmin: boolean) {
  if (isAdmin) return;
  const owner = await providerOwner(providerId);
  if (owner && String(owner) === String(userId)) return;
  const { data } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  if (!data?.length) throw forbidden("You don't run this business.");
}

/** The owner alone, or an admin — for moving money. */
async function assertOwner(userId: string, providerId: string, isAdmin: boolean) {
  if (isAdmin) return;
  const owner = await providerOwner(providerId);
  if (!owner || String(owner) !== String(userId)) throw forbidden("You don't own this business.");
}

async function finish(id: string, status: string, extra: Record<string, unknown>): Promise<PayoutRow> {
  const { data, error } = await db().from("provider_payouts").update({ status, ...extra }).eq("id", id).select().single();
  if (error || !data) throw new HttpError(503, "Could not update the payout.");
  return data as PayoutRow;
}

async function notify(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const { error } = await db().from("user_notifications").insert(rows);
  if (error) console.warn(`[payout] notification failed: ${error.message}`);
}

async function notifyAdmins(row: PayoutRow, type: string, title: string, body: (name: string, dollars: string) => string) {
  const [{ data: p }, { data: admins }] = await Promise.all([
    db().from("providers").select("name").eq("id", row.provider_id).maybeSingle(),
    db().from("user_roles").select("user_id,roles!inner(name)").in("roles.name", ["admin", "super_admin"]),
  ]);
  const name = (p?.name as string | undefined) ?? "A business";
  const dollars = `$${(row.amount_cents / 100).toFixed(2)}`;
  const recipients = [...new Set((admins ?? []).map((r: any) => String(r.user_id)).filter(Boolean))];
  await notify(recipients.map((recipient) => ({
    recipient_user_id: recipient, category: "payout", type, title, body: body(name, dollars),
    related_entity_type: "provider_payout", related_entity_id: row.id, action_url: "/admin/payments",
  })));
}

async function notifyOwner(row: PayoutRow, decision: "paid" | "failed", note: string | null) {
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", row.provider_id).maybeSingle();
  if (!p?.admin_user_id) return;
  const dollars = `$${(row.amount_cents / 100).toFixed(2)}`;
  const copy = decision === "paid"
    ? { title: "Payout sent", body: `${dollars} is on its way to you.` }
    : { title: "Payout could not be sent", body: `${dollars} did not go through and is available again.${note ? ` ${note}` : ""}` };
  await notify([{
    recipient_user_id: p.admin_user_id, category: "payout", type: `payout_${decision}`, ...copy,
    related_entity_type: "provider_payout", related_entity_id: row.id, action_url: `/my-provider/${row.provider_id}`,
  }]);
}

async function minimumCents(): Promise<number> {
  const { data } = await db().from("global_settings").select("value").eq("key", "payouts_min_cents").maybeSingle();
  const v = Number(data?.value);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 100;
}

payouts.get("/account/providers/:providerId/payouts", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("providerId");
  await assertRuns(user.id, providerId, isSuperAdmin(user.roles));
  const { data, error } = await db().from("provider_payouts").select("*").eq("provider_id", providerId).order("created_at", { ascending: false });
  if (error) throw new HttpError(503, "Could not read payouts.");
  return c.json(data ?? []);
});

payouts.get("/account/providers/:providerId/payouts/available", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("providerId");
  const admin = isSuperAdmin(user.roles);
  await assertRuns(user.id, providerId, admin);
  const summary = await summarize(providerId);
  let canWithdraw = true;
  try { await assertOwner(user.id, providerId, admin); } catch { canWithdraw = false; }
  return c.json({ ...summary, canWithdraw });
});

payouts.post("/account/providers/:providerId/payouts/request", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("providerId");
  await assertOwner(user.id, providerId, isSuperAdmin(user.roles));

  const body = await c.req.json().catch(() => ({})) as { amountCents?: unknown; destination?: unknown; note?: unknown };
  const amount = Math.round(Number(body.amountCents));
  if (!Number.isInteger(Number(body.amountCents)) || !Number.isFinite(amount) || amount <= 0) {
    throw badRequest("A payout amount must be a positive number of cents.");
  }
  const destination = String(body.destination ?? "").trim();
  if (!destination) throw badRequest("Where should the money go? Add a Lightning or Bitcoin address.");
  const dest = classifyPayoutDestination(destination);
  const problem = payoutDestinationProblem(dest);
  if (problem) throw badRequest(problem);

  const summary = await summarize(providerId);
  if (amount > summary.availableCents) {
    throw badRequest(
      `You can withdraw up to $${(summary.availableCents / 100).toFixed(2)} right now ` +
      `(earned $${(summary.earnedCents / 100).toFixed(2)}, already requested or paid ` +
      `$${(summary.committedCents / 100).toFixed(2)}).`,
    );
  }

  let instant = payoutsEnabled();
  let wallet: Awaited<ReturnType<typeof planWallet>> | null = null;
  if (instant) {
    const min = await minimumCents();
    if (amount < min) throw badRequest(`The smallest withdrawal is $${(min / 100).toFixed(2)}.`);
    wallet = await planWallet(amount, dest.kind as "lightning_address" | "onchain");
    // Neither wallet can cover it right now: queue it for an admin rather
    // than send a payment that is certain to bounce.
    if (wallet.from === "none") {
      console.warn(`[payout] wallets short for ${providerId}: ${wallet.reason}`);
      instant = false;
    }
  }

  const now = new Date().toISOString();
  const { data: created, error } = await db().from("provider_payouts").insert({
    provider_id: providerId,
    amount_cents: amount,
    // Claimed before it is sent: `sending` counts as committed.
    status: instant ? "sending" : "requested",
    destination,
    note: typeof body.note === "string" ? body.note : null,
    requested_by: user.id,
    requested_at: now,
    created_by: user.id,
    paid_at: null,
  }).select().single();
  if (error || !created) throw badRequest(`The request could not be recorded.`);
  const row = created as PayoutRow;

  if (!instant) {
    await notifyAdmins(row, "payout_requested", "Payout requested", (name, dollars) => `${name} asked to withdraw ${dollars}.`);
    return c.json(row, 201);
  }

  // Verify AFTER claiming: two withdrawals racing both see the same room
  // before; after both claims, the total tells — and the loser voids itself.
  const after = await summarize(providerId);
  if (after.committedCents > after.earnedCents) {
    await finish(row.id, "rejected", { decision_note: "Another withdrawal was in flight; this one would have exceeded the balance." });
    throw badRequest("Another withdrawal is already in progress. Check your payouts and try again.");
  }

  const memo = `EverySub payout ${row.id.slice(0, 8)}`;
  const from = wallet && (wallet.from === "usd" || wallet.from === "btc") ? wallet : { from: "usd" as const, walletId: Deno.env.get("BLINK_WALLET_ID") ?? "" };
  let result: Awaited<ReturnType<typeof sendPayout>>;
  try {
    result = await sendPayout({ destination: dest as { kind: "lightning_address" | "onchain"; value: string }, amountCents: amount, memo, wallet: from });
  } catch (err) {
    // We do not know whether anything left — a human reads the wallet.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[payout] ${row.id}: send threw — ${message}`);
    return c.json(await finish(row.id, "failed", { send_error: `Could not reach Blink: ${message}` }), 201);
  }

  const method = dest.kind === "onchain" ? "onchain" : "lightning";
  if (result.status === "SUCCESS") {
    const paid = await finish(row.id, "paid", {
      paid_at: new Date().toISOString(), method,
      reference: `${memo} · ${result.sentAmount} ${result.sentUnit} · ${from.from.toUpperCase()} wallet`,
      send_error: null,
    });
    await notifyOwner(paid, "paid", null);
    await notifyAdmins(paid, "payout_sent", "Payout sent", (name, dollars) => `${dollars} went to ${name}.`);
    return c.json(paid, 201);
  }
  if (result.status === "PENDING") {
    return c.json(await finish(row.id, "sending", { method, reference: memo, send_error: null }), 201);
  }
  const reason = result.error ?? (result.status === "ALREADY_PAID" ? "Blink says this was already paid." : "Blink refused the payment.");
  const failed = await finish(row.id, "failed", { send_error: reason });
  await notifyOwner(failed, "failed", reason);
  return c.json(failed, 201);
});
