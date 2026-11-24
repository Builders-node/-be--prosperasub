import { Hono } from "hono";
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

/** Get one item. The server re-reads what is left; the button is only a request. */
redeem.post("/redeem/:providerId", async (c) => {
  const user = await requireAccount(c);
  if (!UUID_RE.test(user.id)) throw new HttpError(409, "Your account isn't fully set up yet — sign out and in again.");
  const provider = await readProvider(c.req.param("providerId"));
  const b = await c.req.json().catch(() => ({})) as { table?: string; subscriptionId?: string; itemKey?: string };
  const subs = await whatTheyHave(user.id, provider);
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
      .update({ status: "done", updated_at: new Date().toISOString(), completion: { collected_at: new Date().toISOString(), via: "till_qr" } })
      .eq("id", occurrenceId).eq("status", "scheduled").select("id");
    if (error) throw new HttpError(503, "Could not record it.");
    if (!flipped?.length) throw new HttpError(409, "Already collected.");
  }
  const { data: row, error } = await db().from("redemptions").insert({
    provider_id: provider.id, user_id: user.id, subscription_table: sub.table, subscription_id: sub.id,
    plan_name: sub.planName, item_key: occurrenceId ? `occ:${occurrenceId}` : item.key, item_label: item.label,
    occurrence_id: occurrenceId, method: "customer", day,
  }).select("id,created_at").single();
  if (error) {
    if (occurrenceId) await db().from("service_occurrences").update({ status: "scheduled" }).eq("id", occurrenceId);
    throw new HttpError(/duplicate|unique/i.test(error.message) ? 409 : 503,
      /duplicate|unique/i.test(error.message) ? "Already collected today." : /redemptions/.test(error.message) ? "Collecting isn't switched on yet." : "Could not record it.");
  }

  // The business hears about it in the app (no email for every coffee).
  const audience = await providerAudience(provider.id);
  if (audience) {
    const { data: me } = await db().from("users").select("name,display_name,email").eq("id", user.id).maybeSingle();
    const who = me?.display_name || me?.name || "A customer";
    await tellProvider(audience, {
      type: "provider_redemption", title: `${who} collected ${item.label}`,
      body: `${sub.planName} — at the till.`, email: false,
      relatedEntityType: "redemption", relatedEntityId: String(row.id),
    }).catch(() => undefined);
  }
  return c.json({ ok: true, id: row.id, at: row.created_at, label: item.label, planName: sub.planName, business: provider.name }, 201);
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
