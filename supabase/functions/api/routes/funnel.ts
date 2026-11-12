import { Hono } from "hono";
import { optionalSubject, requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";

/**
 * The sales funnel, per business (table funnel_events).
 *
 *   POST /funnel/events                    {providerId, planRef?, stage, sessionId}   public
 *   GET  /account/providers/:id/funnel?days=30                                       owner, member, admin
 *
 * Four stages are recorded by the browser — saw the business, opened a plan,
 * started checkout, picked a way to pay — and the fifth, PAID, is counted from
 * the orders themselves (subscriptions_unified), so it is the real number even
 * when a tracker was blocked. Each stage counts distinct browser sessions.
 *
 * The write is public (a visitor needs no account), so it is narrow: a known
 * stage, a live business, a sane session id, one row per session per stage per
 * plan per day (unique index). Nothing personal is stored.
 */
export const funnel = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^[0-9a-zA-Z_-]{1,64}$/;
const SESSION_RE = /^[0-9a-zA-Z_-]{8,64}$/;
const STAGES = ["provider_view", "plan_view", "checkout_start", "payment_chosen"] as const;
type Stage = (typeof STAGES)[number];
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

funnel.post("/funnel/events", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const providerId = String(b.providerId ?? "");
  const stage = String(b.stage ?? "") as Stage;
  const sessionId = String(b.sessionId ?? "");
  const planRef = b.planRef == null || b.planRef === "" ? null : String(b.planRef);
  if (!UUID_RE.test(providerId) || !STAGES.includes(stage) || !SESSION_RE.test(sessionId)) throw badRequest("Bad event.");
  if (planRef !== null && !REF_RE.test(planRef)) throw badRequest("Bad plan.");

  const { data: prov } = await db().from("providers").select("id").eq("id", providerId).maybeSingle();
  if (!prov) return c.json({ ok: true }); // a stale link: nothing to count, nothing to say

  const userId = await optionalSubject(c);
  const { error } = await db().from("funnel_events")
    .insert({ provider_id: providerId, plan_ref: planRef, stage, session_id: sessionId, user_id: userId });
  // A repeat (same session, stage, plan and day) hits the unique index — that
  // is the index doing its job. A missing table means the migration is not
  // applied yet: the page must not notice either way.
  if (error && !/duplicate|unique|funnel_events|does not exist/i.test(error.message)) {
    throw new HttpError(503, "Could not record that.");
  }
  return c.json({ ok: true });
});

funnel.get("/account/providers/:id/funnel", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (!isSuperAdmin(user.roles)) {
    const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
    if (!p) throw notFound("Business not found.");
    if (!(p.admin_user_id && String(p.admin_user_id) === String(user.id))) {
      const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", user.id).limit(1);
      if (!m?.length) throw forbidden("You don't run this business.");
    }
  }

  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);

  const { data: events, error } = await db().from("funnel_events")
    .select("stage, plan_ref, session_id")
    .eq("provider_id", providerId).gte("day", sinceDay).limit(50_000);
  if (error) {
    if (/funnel_events|does not exist/i.test(error.message)) return c.json({ enabled: false, days, stages: [], plans: [] });
    throw new HttpError(503, "Could not read the funnel.");
  }

  // Plan refs arrive as whichever id the page had (universal, legacy, a
  // variant's) — fold them onto the OFFER the customer sees.
  const { data: plans } = await db().from("provider_plans")
    .select("id, name, parent_plan_id, source_plan_id").eq("provider_id", providerId);
  const offerOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const p of plans ?? []) {
    const offer = String(p.parent_plan_id ?? p.id);
    offerOf.set(String(p.id), offer);
    if (p.source_plan_id) offerOf.set(String(p.source_plan_id), offer);
    if (!p.parent_plan_id) nameOf.set(String(p.id), p.name);
  }

  const sessions = new Map<Stage, Set<string>>(STAGES.map((s) => [s, new Set<string>()]));
  const perPlan = new Map<string, Map<Stage, Set<string>>>();
  for (const e of events ?? []) {
    const stage = e.stage as Stage;
    sessions.get(stage)?.add(e.session_id);
    if (!e.plan_ref) continue;
    const offer = offerOf.get(String(e.plan_ref)) ?? String(e.plan_ref);
    if (!perPlan.has(offer)) perPlan.set(offer, new Map(STAGES.map((s) => [s, new Set<string>()])));
    perPlan.get(offer)!.get(stage)?.add(e.session_id);
  }

  // Paid — the orders, not a tracker.
  const { data: orders } = await db().from("subscriptions_unified")
    .select("plan_id, paid, created_at").eq("provider_id", providerId).gte("created_at", since.toISOString());
  const paid = (orders ?? []).filter((o) => o.paid);
  const paidByOffer = new Map<string, number>();
  for (const o of paid) {
    const offer = offerOf.get(String(o.plan_id)) ?? String(o.plan_id);
    paidByOffer.set(offer, (paidByOffer.get(offer) ?? 0) + 1);
  }

  const stages = [
    { key: "provider_view", label: "Saw your page", count: sessions.get("provider_view")!.size },
    { key: "plan_view", label: "Opened a plan", count: sessions.get("plan_view")!.size },
    { key: "checkout_start", label: "Started checkout", count: sessions.get("checkout_start")!.size },
    { key: "payment_chosen", label: "Chose how to pay", count: sessions.get("payment_chosen")!.size },
    { key: "paid", label: "Paid", count: paid.length },
  ];
  const planRows = [...new Set([...perPlan.keys(), ...paidByOffer.keys()])]
    .filter((id) => nameOf.has(id))
    .map((id) => ({
      id, name: nameOf.get(id)!,
      views: perPlan.get(id)?.get("plan_view")?.size ?? 0,
      checkouts: perPlan.get(id)?.get("checkout_start")?.size ?? 0,
      paid: paidByOffer.get(id) ?? 0,
    }))
    .sort((a, b) => b.views - a.views);

  return c.json({ enabled: true, days, stages, plans: planRows });
});
