import { db } from "./db.ts";
import { paypal } from "./paypal.ts";

/**
 * "Was this order really paid, and for enough?" — asked of the payment rail,
 * never of the browser.
 *
 * The amount is checked against `payment_checkout_sessions`, which the server
 * writes when the invoice is raised (it records what the invoice was FOR).
 * Without that, a 1-sat Lightning invoice — or one payment hash reused on a
 * second order — confirmed any booking.
 */

const graphqlUrl = () => Deno.env.get("BLINK_GRAPHQL_URL") || "https://api.blink.sv/graphql";
// The checkout key (Receive + Read) — reading invoice state needs nothing more.
const readKey = () => Deno.env.get("BLINK_API_KEY") || Deno.env.get("BLINK_PAYOUT_API_KEY") || "";

async function blinkRead<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  if (!readKey()) return null;
  const res = await fetch(graphqlUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": readKey() },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null) as { data?: T } | null;
  return payload?.data ?? null;
}

export async function lightningPaid(paymentHash: string): Promise<boolean> {
  const d = await blinkRead<{ lnInvoicePaymentStatusByHash?: { status?: string } }>(
    `query S($input: LnInvoicePaymentStatusByHashInput!) { lnInvoicePaymentStatusByHash(input: $input) { status } }`,
    { input: { paymentHash } },
  );
  const status = String(d?.lnInvoicePaymentStatusByHash?.status ?? "").toUpperCase();
  return status === "PAID" || status === "SETTLED";
}

/** A receive to `address` of at least `expectedSats` (3% / 2,500-sat tolerance, as the Nest check). */
export async function onchainPaid(address: string, expectedSats: number | null): Promise<boolean> {
  const d = await blinkRead<{ me?: { defaultAccount?: { wallets?: Array<{ transactions?: { edges?: Array<{ node?: {
    settlementAmount?: number; status?: string; initiationVia?: { address?: string } } }> } }> } } }>(
    `query { me { defaultAccount { wallets { transactions(first: 50) { edges { node {
      settlementAmount status initiationVia { ... on InitiationViaOnChain { address } } } } } } } } }`, {},
  );
  const tolerance = expectedSats ? Math.max(Math.round(expectedSats * 0.03), 2500) : 0;
  for (const w of d?.me?.defaultAccount?.wallets ?? []) {
    for (const e of w.transactions?.edges ?? []) {
      const n = e.node;
      if (!n || n.initiationVia?.address !== address) continue;
      const amount = Number(n.settlementAmount ?? 0);
      const ok = ["SUCCESS", "PENDING"].includes(String(n.status ?? "").toUpperCase());
      if (ok && amount > 0 && (!expectedSats || amount >= expectedSats - tolerance)) return true;
    }
  }
  return false;
}

/** Capture if approved; returns the captured USD cents (0 when not paid). */
export async function paypalCapturedCents(orderId: string): Promise<number> {
  const centsOf = (o: any): number => {
    const caps = (o?.purchase_units ?? []).flatMap((u: any) => u?.payments?.captures ?? []);
    const done = caps.filter((c: any) => String(c?.status).toUpperCase() === "COMPLETED");
    return done.reduce((s: number, c: any) => s + Math.round(Number(c?.amount?.value ?? 0) * 100), 0);
  };
  try {
    let order = await paypal<any>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (String(order?.status).toUpperCase() === "APPROVED") {
      order = await paypal<any>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", body: {} });
    }
    return String(order?.status).toUpperCase() === "COMPLETED" ? centsOf(order) : 0;
  } catch {
    return 0;
  }
}

/** What the invoice for this reference was raised for, per the server's own record. */
export async function sessionFor(reference: string): Promise<{ amountCents: number | null; amountSats: number | null } | null> {
  const { data } = await db().from("payment_checkout_sessions")
    .select("amount_cents,amount_sats").eq("provider_payment_id", reference)
    .order("created_at", { ascending: false }).limit(1);
  const row = data?.[0];
  return row ? { amountCents: row.amount_cents ?? null, amountSats: row.amount_sats ?? null } : null;
}

/** The same payment may settle ONE order. True when another paid order already carries it. */
export async function referenceAlreadyUsed(reference: string, except: { table: string; id: string }): Promise<boolean> {
  const tables = ["rental_bookings", "provider_subscriptions", "food_subscriptions", "cleaning_subscriptions"];
  for (const t of tables) {
    let q = db().from(t).select("id").eq("payment_reference", reference).eq("payment_status", "paid").limit(1);
    if (t === except.table) q = q.neq("id", except.id);
    const { data } = await q;
    if (data?.length) return true;
  }
  return false;
}

/**
 * Verify a payment for `expectedCents` (the price plus the method's fee).
 * Returns a reason when it is not acceptable.
 */
export async function verifyPayment(method: string, reference: string, expectedCents: number):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  const m = method.toLowerCase();
  // A cent of rounding between the fee calculation and the invoice is not a shortfall.
  const enough = (cents: number | null | undefined) => (cents ?? 0) >= expectedCents - 1;

  if (m === "paypal") {
    const captured = await paypalCapturedCents(reference);
    if (!captured) return { ok: false, reason: "payment_not_confirmed" };
    return enough(captured) ? { ok: true } : { ok: false, reason: "amount_too_low" };
  }
  const session = await sessionFor(reference);
  if (!session) return { ok: false, reason: "unknown_invoice" };
  if (!enough(session.amountCents)) return { ok: false, reason: "amount_too_low" };
  if (m === "lightning" || m === "blink") {
    return (await lightningPaid(reference)) ? { ok: true } : { ok: false, reason: "payment_not_confirmed" };
  }
  if (m === "onchain") {
    return (await onchainPaid(reference, session.amountSats)) ? { ok: true } : { ok: false, reason: "payment_not_confirmed" };
  }
  return { ok: false, reason: "unsupported_method" };
}
