import { Hono } from "hono";
import { jwtVerify } from "jose";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { providerAudience, tellProvider } from "../lib/providerAudience.ts";
import { today } from "./paypal-subscriptions.ts";

/**
 * "Get it at the till".
 *
 * The business prints a till QR (→ /redeem/:providerId). A customer scans it
 * in the app and sees, for THAT business only, what their subscriptions there
 * include today and how much is left; pressing Get records one collection
 * (`redemptions`) and the business sees it on its Schedule.
 *
 *   a meal plan   today's scheduled meals (service_occurrences) — Get marks
 *                 the meal done
 *   a counted plan included_quantity × periods bought, less what was collected
 *   anything else one visit a day
 *
 * Cleaning is not here: it is done at the customer's home, not collected.
 */
export const redeem = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");
/** Roatán has no daylight saving: a business day is always UTC−6. */
const dayBounds = (day: string) => {
  const start = new Date(`${day}T00:00:00-06:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
};
const tidy = (key: string) => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

type Item = { key: string; label: string; remaining: number | null; total: number | null; available: boolean; note: string | null };
type Sub = { table: "provider_subscriptions" | "food_subscriptions"; id: string; planName: string; endDate: string | null; items: Item[] };

async function readProvider(providerId: string) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  const { data } = await db().from("providers")
    .select("id,name,avatar_url,status,source_service_key,source_provider_id").eq("id", providerId).maybeSingle();
  if (!data) throw notFound("Business not found.");
  return data as { id: string; name: string; avatar_url: string | null; status: string | null; source_service_key: string | null; source_provider_id: string | null };
}

/** Everything this person can collect at this business today. */
async function whatTheyHave(userId: string, provider: Awaited<ReturnType<typeof readProvider>>): Promise<Sub[]> {
  const day = today();
  const subs: Sub[] = [];

  // Universal plans and beach memberships.
  const { data: ps } = await db().from("provider_subscriptions")
    .select("id,plan_id,status,payment_status,periods_paid,end_date,metadata")
    .eq("provider_id", provider.id).eq("user_id", userId).eq("status", "active").eq("payment_status", "paid");
  for (const s of ps ?? []) {
    if (s.end_date && String(s.end_date).slice(0, 10) < day) continue;
    let plan: Record<string, any> | null = null;
    if (s.plan_id) {
      const { data } = await db().from("provider_plans")
        .select("id,name,included_quantity,included_unit,parent_plan_id").eq("id", s.plan_id).maybeSingle();
      plan = data;
      if (plan && plan.included_quantity == null && plan.parent_plan_id) {
        const { data: parent } = await db().from("provider_plans")
          .select("included_quantity,included_unit").eq("id", plan.parent_plan_id).maybeSingle();
        if (parent?.included_quantity != null) plan = { ...plan, ...parent };
      }
    }
    const planName = String(plan?.name ?? s.metadata?.plan_name ?? "Subscription");
    const { data: used } = await db().from("redemptions")
      .select("item_key,day").eq("subscription_table", "provider_subscriptions").eq("subscription_id", s.id).is("voided_at", null);
    let item: Item;
    if (plan?.included_quantity != null && Number(plan.included_quantity) > 0) {
      const total = Number(plan.included_quantity) * Math.max(1, Number(s.periods_paid) || 1);
      const remaining = Math.max(0, total - (used ?? []).filter((u) => u.item_key === "unit").length);
      item = { key: "unit", label: tidy(String(plan.included_unit ?? "Visit")), remaining, total, available: remaining > 0, note: remaining > 0 ? null : "All used" };
    } else {
      const doneToday = (used ?? []).some((u) => u.item_key === "visit" && String(u.day) === day);
      item = { key: "visit", label: "Visit", remaining: null, total: null, available: !doneToday, note: doneToday ? "Already collected today" : null };
    }
    subs.push({ table: "provider_subscriptions", id: String(s.id), planName, endDate: s.end_date ? String(s.end_date).slice(0, 10) : null, items: [item] });
  }

  // Meal plans: today's scheduled meals, one Get each.
  if (provider.source_service_key === "food" && provider.source_provider_id) {
    const { data: fs } = await db().from("food_subscriptions")
      .select("id,meal_plan_id,status,payment_status,end_date")
      .eq("provider_id", provider.source_provider_id).eq("user_id", userId).eq("status", "active").eq("payment_status", "paid");
    if (fs?.length) {
      const { from, to } = dayBounds(day);
      const [{ data: occ }, { data: names }, { data: plans }] = await Promise.all([
        db().from("service_occurrences").select("id,item_key,status,starts_at,source_subscription_id")
          .eq("provider_id", provider.id).eq("user_id", userId).gte("starts_at", from).lt("starts_at", to).order("starts_at"),
        db().from("provider_items").select("key,label").eq("provider_id", provider.id),
        db().from("food_meal_plans").select("id,name").in("id", fs.map((f) => f.meal_plan_id).filter(Boolean)),
      ]);
      const labelOf = new Map((names ?? []).map((n) => [String(n.key), String(n.label)]));
      const planOf = new Map((plans ?? []).map((p) => [String(p.id), String(p.name)]));
      for (const f of fs) {
        if (f.end_date && String(f.end_date).slice(0, 10) < day) continue;
        const mine = (occ ?? []).filter((o) => String(o.source_subscription_id ?? "") === String(f.id));
        const items: Item[] = mine.map((o) => ({
          key: `occ:${o.id}`,
          label: labelOf.get(String(o.item_key ?? "")) ?? tidy(String(o.item_key ?? "Meal")),
          remaining: o.status === "scheduled" ? 1 : 0,
          total: 1,
          available: o.status === "scheduled",
          note: o.status === "done" ? "Collected" : o.status === "scheduled" ? null : "Not today",
        }));
        subs.push({
          table: "food_subscriptions", id: String(f.id), planName: planOf.get(String(f.meal_plan_id)) ?? "Meal plan",
          endDate: f.end_date ? String(f.end_date).slice(0, 10) : null,
          items: items.length ? items : [{ key: "none", label: "Nothing scheduled today", remaining: 0, total: 0, available: false, note: null }],
        });
      }
    }
  }
  return subs;
}

/** What the scanning customer has at this business. */
redeem.get("/redeem/:providerId", async (c) => {
  const user = await requireAccount(c);
  if (!UUID_RE.test(user.id)) throw new HttpError(409, "Your account isn't fully set up yet — sign out and in again.");
  const provider = await readProvider(c.req.param("providerId"));
  const subscriptions = await whatTheyHave(user.id, provider);
  return c.json({ business: { id: provider.id, name: provider.name, avatar: provider.avatar_url }, day: today(), subscriptions });
});

/**
 * Record one collection — the one path for both the customer's own Get and the
 * till (PIN). Re-reads what is left; the button is only a request.
 */
async function collect(provider: Awaited<ReturnType<typeof readProvider>>, userId: string,
  b: { table?: string; subscriptionId?: string; itemKey?: string }, method: "customer" | "pin") {
  const subs = await whatTheyHave(userId, provider);
  const sub = subs.find((s) => s.table === b.table && s.id === String(b.subscriptionId ?? ""));
  if (!sub) throw notFound("That subscription isn't active at this business.");
  const item = sub.items.find((i) => i.key === b.itemKey);
  if (!item) throw badRequest("Nothing like that in this subscription.");
  if (!item.available) throw new HttpError(409, item.note ?? "Nothing left to collect.");

  const day = today();
  const occurrenceId = item.key.startsWith("occ:") ? item.key.slice(4) : null;
  if (occurrenceId) {
    // Compare-and-set: two presses cannot both collect the same meal.
    const { data: flipped, error } = await db().from("service_occurrences")
      .update({ status: "done", updated_at: new Date().toISOString(), completion: { collected_at: new Date().toISOString(), via: method === "pin" ? "till_pin" : "till_qr" } })
      .eq("id", occurrenceId).eq("status", "scheduled").select("id");
    if (error) throw new HttpError(503, "Could not record it.");
    if (!flipped?.length) throw new HttpError(409, "Already collected.");
  }
  const { data: row, error } = await db().from("redemptions").insert({
    provider_id: provider.id, user_id: userId, subscription_table: sub.table, subscription_id: sub.id,
    plan_name: sub.planName, item_key: occurrenceId ? `occ:${occurrenceId}` : item.key, item_label: item.label,
    occurrence_id: occurrenceId, method, day,
  }).select("id,created_at").single();
  if (error) {
    if (occurrenceId) await db().from("service_occurrences").update({ status: "scheduled" }).eq("id", occurrenceId);
    throw new HttpError(/duplicate|unique/i.test(error.message) ? 409 : 503,
      /duplicate|unique/i.test(error.message) ? "Already collected today." : /redemptions/.test(error.message) ? "Collecting isn't switched on yet." : "Could not record it.");
  }

  // The business hears about it in the app (no email for every coffee).
  const audience = await providerAudience(provider.id);
  const { data: me } = await db().from("users").select("name,display_name").eq("id", userId).maybeSingle();
  const who = me?.display_name || me?.name || "A customer";
  if (audience) {
    await tellProvider(audience, {
      type: "provider_redemption", title: `${who} collected ${item.label}`,
      body: `${sub.planName} — ${method === "pin" ? "recorded at the till" : "at the till"}.`, email: false,
      relatedEntityType: "redemption", relatedEntityId: String(row.id),
    }).catch(() => undefined);
  }
  return { ok: true, id: row.id, at: row.created_at, label: item.label, planName: sub.planName, business: provider.name, customer: who };
}

/** The customer's own Get, after scanning the till QR. */
redeem.post("/redeem/:providerId", async (c) => {
  const user = await requireAccount(c);
  if (!UUID_RE.test(user.id)) throw new HttpError(409, "Your account isn't fully set up yet — sign out and in again.");
  const provider = await readProvider(c.req.param("providerId"));
  const b = await c.req.json().catch(() => ({})) as { table?: string; subscriptionId?: string; itemKey?: string };
  return c.json(await collect(provider, user.id, b, "customer"), 201);
});

// ── The business's side ──────────────────────────────────────────────────────

async function assertRuns(userId: string, providerId: string, roles: string[]) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (isSuperAdmin(roles)) return;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (p.admin_user_id && String(p.admin_user_id) === String(userId)) return;
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  if (!m?.length) throw forbidden("You don't run this business.");
}

/** What was collected on a day (default today), newest first. */
redeem.get("/account/providers/:id/redemptions", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("day") ?? "") ? String(c.req.query("day")) : today();
  const { data, error } = await db().from("redemptions")
    .select("id,user_id,plan_name,item_label,method,created_at,voided_at")
    .eq("provider_id", providerId).eq("day", day).order("created_at", { ascending: false }).limit(500);
  if (error) throw new HttpError(503, /redemptions/.test(error.message) ? "Collecting isn't switched on yet." : "Could not read the list.");
  const ids = [...new Set((data ?? []).map((r) => String(r.user_id ?? "")).filter((id) => UUID_RE.test(id)))];
  const { data: people } = ids.length ? await db().from("users").select("id,name,display_name").in("id", ids) : { data: [] as any[] };
  const nameOf = new Map((people ?? []).map((u: any) => [String(u.id), u.display_name || u.name || "Customer"]));
  return c.json({
    day,
    redemptions: (data ?? []).map((r) => ({
      id: r.id, customer: nameOf.get(String(r.user_id)) ?? "Customer", plan: r.plan_name, item: r.item_label,
      method: r.method, at: r.created_at, voided: !!r.voided_at,
    })),
  });
});

/** Undo a mistaken collection: the item is available again. */
redeem.post("/account/providers/:id/redemptions/:rid/void", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const rid = c.req.param("rid");
  if (!UUID_RE.test(rid)) throw notFound("Not found.");
  const { data, error } = await db().from("redemptions")
    .update({ voided_at: new Date().toISOString(), voided_by: UUID_RE.test(user.id) ? user.id : null })
    .eq("id", rid).eq("provider_id", providerId).is("voided_at", null).select("occurrence_id");
  if (error) throw new HttpError(503, "Could not undo it.");
  if (!data?.length) throw new HttpError(409, "Already undone.");
  const occ = data[0].occurrence_id;
  if (occ) await db().from("service_occurrences").update({ status: "scheduled", updated_at: new Date().toISOString() }).eq("id", occ).eq("status", "done");
  return c.json({ ok: true });
});


// ── The till: staff scan the customer's QR and enter the business PIN ───────

const PIN_RE = /^\d{4,6}$/;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60_000;

function verifySecret(): Uint8Array {
  const s = Deno.env.get("JWT_VERIFY_SECRET");
  if (!s || s.length < 32) throw new HttpError(503, "Verification is not configured");
  return new TextEncoder().encode(s);
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");

/** PBKDF2-SHA256, 100k rounds, per-business salt. */
async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 }, key, 256);
  return hex(bits);
}

/** Constant-time string compare. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * The customer's subscription QR (the same signed token /verify reads) →
 * who they are, which business that subscription is with, and that one
 * subscription as it stands today. A token without a subscription in it (the
 * old account-wide code) is refused: the till must know which business.
 */
async function fromCustomerQr(token: unknown) {
  if (typeof token !== "string" || !token) throw badRequest("Scan the customer's code again.");
  let userId: string; let sid: string;
  try {
    const { payload } = await jwtVerify(token, verifySecret(), { algorithms: ["HS256"] });
    if (payload.typ !== "verify" || !payload.sub) throw new Error("typ");
    if (typeof payload.sid !== "string" || !payload.sid) {
      throw new HttpError(409, "Ask the customer to open the subscription itself and show its QR.");
    }
    userId = String(payload.sub); sid = payload.sid;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, "This code has expired — ask the customer to show it again.");
  }
  if (!UUID_RE.test(userId)) throw notFound("Customer not found.");

  // Which business: the subscription row names it (food by its legacy id).
  let providerId: string | null = null;
  const { data: ps } = UUID_RE.test(sid)
    ? await db().from("provider_subscriptions").select("provider_id,user_id").eq("id", sid).maybeSingle()
    : { data: null };
  if (ps?.provider_id && String(ps.user_id) === userId) providerId = String(ps.provider_id);
  if (!providerId && UUID_RE.test(sid)) {
    const { data: fs } = await db().from("food_subscriptions").select("provider_id,user_id").eq("id", sid).maybeSingle();
    if (fs?.provider_id && String(fs.user_id) === userId) {
      const { data: p } = await db().from("providers").select("id")
        .eq("source_service_key", "food").eq("source_provider_id", String(fs.provider_id)).maybeSingle();
      providerId = p?.id ? String(p.id) : null;
    }
  }
  if (!providerId) throw new HttpError(409, "This subscription can't be collected at a till.");
  const provider = await readProvider(providerId);
  const sub = (await whatTheyHave(userId, provider)).find((s) => s.id === sid) ?? null;
  const { data: u } = await db().from("users").select("name,display_name").eq("id", userId).maybeSingle();
  const { data: pin } = await db().from("provider_till_pins").select("provider_id").eq("provider_id", provider.id).maybeSingle();
  return { userId, provider, sub, customer: (u?.display_name || u?.name || "Customer") as string, hasPin: !!pin };
}

/** Staff scanned a customer's QR: who, which business, what is available today. No sign-in. */
redeem.post("/till/lookup", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { token?: unknown };
  const r = await fromCustomerQr(b.token);
  return c.json({
    business: { id: r.provider.id, name: r.provider.name },
    customer: r.customer,
    hasPin: r.hasPin,
    subscription: r.sub,
    reason: r.sub ? null : "This subscription isn't active.",
  });
});

/** Staff press Get and type the business PIN. Five wrong PINs lock the till for 15 minutes. */
redeem.post("/till/redeem", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { token?: unknown; itemKey?: unknown; pin?: unknown };
  const r = await fromCustomerQr(b.token);
  if (!r.sub) throw new HttpError(409, "This subscription isn't active.");
  const pin = String(b.pin ?? "").trim();
  if (!PIN_RE.test(pin)) throw badRequest("The PIN is 4 to 6 digits.");

  const { data: row } = await db().from("provider_till_pins")
    .select("pin_hash,salt,failed_count,locked_until").eq("provider_id", r.provider.id).maybeSingle();
  if (!row) throw new HttpError(409, "This business hasn't set a till PIN yet — the owner sets it in the workspace.");
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    const mins = Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong PINs — try again in ${mins} min.`);
  }
  if (!same(await hashPin(pin, String(row.salt)), String(row.pin_hash))) {
    const fails = (Number(row.failed_count) || 0) + 1;
    await db().from("provider_till_pins").update({
      failed_count: fails >= MAX_TRIES ? 0 : fails,
      locked_until: fails >= MAX_TRIES ? new Date(Date.now() + LOCK_MS).toISOString() : null,
    }).eq("provider_id", r.provider.id);
    throw new HttpError(403, fails >= MAX_TRIES ? "Too many wrong PINs — the till is locked for 15 minutes." : `Wrong PIN. ${MAX_TRIES - fails} tries left.`);
  }
  if (Number(row.failed_count) > 0) {
    await db().from("provider_till_pins").update({ failed_count: 0, locked_until: null }).eq("provider_id", r.provider.id);
  }
  return c.json(await collect(r.provider, r.userId, { table: r.sub.table, subscriptionId: r.sub.id, itemKey: String(b.itemKey ?? "") }, "pin"), 201);
});

/** Whether the till PIN is set (never the PIN). The team may know; only the owner changes it. */
redeem.get("/account/providers/:id/till-pin", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const { data } = await db().from("provider_till_pins").select("updated_at").eq("provider_id", providerId).maybeSingle();
  return c.json({ set: !!data, updatedAt: data?.updated_at ?? null });
});

/** Set or change the till PIN — owner or admin. */
redeem.put("/account/providers/:id/till-pin", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (!isSuperAdmin(user.roles)) {
    const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
    if (!p) throw notFound("Business not found.");
    if (String(p.admin_user_id ?? "") !== String(user.id)) throw forbidden("Only the owner can change the till PIN.");
  }
  const b = await c.req.json().catch(() => ({})) as { pin?: unknown };
  const pin = String(b.pin ?? "").trim();
  if (!PIN_RE.test(pin)) throw badRequest("The PIN is 4 to 6 digits.");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    throw badRequest("Pick a PIN that's harder to guess than 1111 or 1234.");
  }
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const { error } = await db().from("provider_till_pins").upsert({
    provider_id: providerId, pin_hash: await hashPin(pin, salt), salt,
    failed_count: 0, locked_until: null, updated_by: UUID_RE.test(user.id) ? user.id : null, updated_at: new Date().toISOString(),
  }, { onConflict: "provider_id" });
  if (error) throw new HttpError(503, /provider_till_pins/.test(error.message) ? "The till PIN isn't switched on yet." : "Could not save the PIN.");
  return c.json({ set: true });
});
