import { Hono } from "hono";
import { requireAccount, requireAdmin, type AuthUser } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { summarize } from "../lib/earnings.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";
import { superAdminIds, usd } from "../lib/providerAudience.ts";

/**
 * Paid placements — a business promoting itself or one of its offers.
 *
 *  boost    — a switch. Free to turn on; the business pays `extra pct` more
 *             commission on orders that came from a placement (the DB trigger
 *             stamps it, from a click by the buyer on that business within 7
 *             days). Boosted businesses fill the "Featured" rails after the
 *             paid slots.
 *  featured — a fixed slot for N weeks, paid up front from the payout balance
 *             as a provider_payouts row (method 'promotion', status 'paid'),
 *             so "available = earned − committed" stays the only arithmetic.
 *             Slots are few on purpose; claim-then-verify keeps two buyers of
 *             the last slot from both getting it.
 */
export const promotions = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");
const WEEK_MS = 7 * 86_400_000;

type Placement = "home" | "service";

export interface PromoSettings {
  homeWeekCents: number; serviceWeekCents: number; boostPct: number; slotsHome: number; slotsService: number;
}
const SETTING_KEYS: Record<keyof PromoSettings, [string, number]> = {
  homeWeekCents: ["promo_featured_home_week_cents", 2500],
  serviceWeekCents: ["promo_featured_service_week_cents", 1500],
  boostPct: ["promo_boost_extra_pct", 5],
  slotsHome: ["promo_slots_home", 3],
  slotsService: ["promo_slots_service", 2],
};

async function settings(): Promise<PromoSettings> {
  const keys = Object.values(SETTING_KEYS).map(([k]) => k);
  const { data } = await db().from("global_settings").select("key,value").in("key", keys);
  const byKey = new Map((data ?? []).map((r) => [r.key, Number(r.value)]));
  const out = {} as PromoSettings;
  for (const [field, [key, fallback]] of Object.entries(SETTING_KEYS)) {
    const v = byKey.get(key);
    (out as any)[field] = Number.isFinite(v) && (v as number) >= 0 ? v : fallback;
  }
  return out;
}

async function runsBusiness(user: AuthUser, providerId: string): Promise<{ owner: boolean }> {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (isSuperAdmin(user.roles)) return { owner: true };
  if (p.admin_user_id && String(p.admin_user_id) === String(user.id)) return { owner: true };
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", user.id).limit(1);
  if (!m?.length) throw forbidden("You don't run this business.");
  return { owner: false };
}

/** A promotion is live when it is active and today sits inside its window. */
// deno-lint-ignore no-explicit-any
function liveFilter(q: any, at = new Date().toISOString()): any {
  return q.eq("status", "active").lte("starts_at", at).or(`ends_at.is.null,ends_at.gt.${at}`);
}

// ── Storefront ───────────────────────────────────────────────────────────────

/**
 * What the Featured rail shows: paid slots first (oldest purchase first — they
 * paid for the week), then boosted businesses, shuffled so no boost owns the
 * first place for ever. Only live businesses.
 */
promotions.get("/promotions/active", async (c) => {
  const placement = c.req.query("placement") === "service" ? "service" : "home";
  const archetype = c.req.query("archetype") ?? null;
  const s = await settings();
  const limit = placement === "home" ? Math.max(s.slotsHome, 1) + 3 : Math.max(s.slotsService, 1) + 2;

  let q = db().from("provider_promotions")
    .select("id,kind,placement,plan_id,provider_id,created_at,providers!inner(id,name,description,avatar_url,banner_url,archetype_key,unit,status,source_service_key,source_provider_id)");
  q = liveFilter(q);
  q = q.in("providers.status", ["active", "approved"]);
  if (placement === "service") {
    if (!archetype) throw badRequest("archetype is required for the service placement");
    q = q.eq("providers.archetype_key", archetype);
  }
  const { data, error } = await q.order("created_at", { ascending: true }).limit(100);
  if (error) {
    // Not migrated yet: an empty rail, never a broken page.
    if (/provider_promotions|does not exist/i.test(error.message)) return c.json([]);
    throw new HttpError(503, "Could not read promotions.");
  }
  const rows = (data ?? []) as any[];
  const featured = rows.filter((r) => r.kind === "featured" && r.placement === placement);
  const boosts = rows.filter((r) => r.kind === "boost").sort(() => Math.random() - 0.5);
  const seen = new Set<string>();
  const picked = [...featured, ...boosts].filter((r) => (seen.has(r.provider_id) ? false : (seen.add(r.provider_id), true))).slice(0, limit);

  const planIds = picked.map((r) => r.plan_id).filter(Boolean);
  const { data: plans } = planIds.length
    ? await db().from("provider_plans").select("id,name,price_cents,period,status,source_plan_id,source_service_key").in("id", planIds)
    : { data: [] as any[] };
  const planById = new Map((plans ?? []).filter((p: any) => p.status === "active").map((p: any) => [p.id, p]));

  c.header("Cache-Control", "public, max-age=60");
  return c.json(picked.map((r) => ({
    id: r.id,
    kind: r.kind,
    provider: {
      id: r.providers.id, name: r.providers.name, description: r.providers.description,
      avatarUrl: r.providers.avatar_url, bannerUrl: r.providers.banner_url,
      archetypeKey: r.providers.archetype_key, unit: r.providers.unit,
      sourceServiceKey: r.providers.source_service_key, sourceProviderId: r.providers.source_provider_id,
    },
    plan: r.plan_id && planById.get(r.plan_id) ? (() => {
      const p = planById.get(r.plan_id);
      return { id: p.id, name: p.name, priceCents: p.price_cents, period: p.period, sourcePlanId: p.source_plan_id };
    })() : null,
  })));
});

/**
 * An impression or a click. Public; attaches the signed-in user when there is
 * one, and hands that user any earlier anonymous clicks from the same browser
 * session — so a visitor who clicks, then signs in, then buys, is attributed.
 */
promotions.post("/promotions/events", async (c) => {
  const b = await c.req.json().catch(() => ({})) as { promotionId?: unknown; kind?: unknown; sessionId?: unknown };
  const promotionId = String(b.promotionId ?? "");
  const kind = b.kind === "click" ? "click" : b.kind === "impression" ? "impression" : null;
  const sessionId = typeof b.sessionId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.sessionId) ? b.sessionId : null;
  if (!UUID_RE.test(promotionId) || !kind) return c.json({ ok: false }, 400);

  let userId: string | null = null;
  if (c.req.header("authorization")) {
    try { userId = (await requireAccount(c)).id; } catch { userId = null; }
  }
  const { data: promo } = await db().from("provider_promotions").select("id,provider_id").eq("id", promotionId).maybeSingle();
  if (!promo) return c.json({ ok: false }, 404);

  // One impression per session per promotion per day is plenty.
  if (kind === "impression" && sessionId) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data: seen } = await db().from("promotion_events").select("id")
      .eq("promotion_id", promotionId).eq("kind", "impression").eq("session_id", sessionId).gte("created_at", since).limit(1);
    if (seen?.length) return c.json({ ok: true, dup: true });
  }
  await db().from("promotion_events").insert({
    promotion_id: promotionId, provider_id: promo.provider_id, kind, session_id: sessionId, user_id: userId,
  });
  if (userId && sessionId) {
    await db().from("promotion_events").update({ user_id: userId })
      .eq("session_id", sessionId).is("user_id", null).eq("kind", "click");
  }
  return c.json({ ok: true });
});

// ── The business's own side ──────────────────────────────────────────────────

async function statsFor(promotionIds: string[], sinceIso: string) {
  const out = new Map<string, { impressions: number; clicks: number; orders: number; revenueCents: number }>();
  for (const id of promotionIds) out.set(id, { impressions: 0, clicks: 0, orders: 0, revenueCents: 0 });
  if (!promotionIds.length) return out;
  for (const kind of ["impression", "click"] as const) {
    for (const id of promotionIds) {
      const { count } = await db().from("promotion_events").select("id", { count: "exact", head: true })
        .eq("promotion_id", id).eq("kind", kind).gte("created_at", sinceIso);
      const s = out.get(id)!;
      if (kind === "impression") s.impressions = count ?? 0; else s.clicks = count ?? 0;
    }
  }
  // Orders the placements brought — paid ones, at what the order is worth.
  const tables: Array<[string, string, (r: any) => number]> = [
    ["provider_subscriptions", "price_cents,periods_paid", (r) => Number(r.price_cents || 0) * Math.max(1, Number(r.periods_paid || 1))],
    ["food_subscriptions", "weekly_price_cents,commitment_weeks", (r) => Number(r.weekly_price_cents || 0) * Math.max(1, Number(r.commitment_weeks || 1))],
    ["cleaning_subscriptions", "total_price_cents", (r) => Number(r.total_price_cents || 0)],
    ["rental_bookings", "total_cents", (r) => Number(r.total_cents || 0)],
  ];
  for (const [t, cols, value] of tables) {
    const { data, error } = await db().from(t).select(`promotion_id,${cols}`)
      .in("promotion_id", promotionIds).eq("payment_status", "paid").gte("created_at", sinceIso);
    if (error) continue;
    for (const r of (data ?? []) as any[]) {
      const s = out.get(String(r.promotion_id));
      if (!s) continue;
      s.orders += 1;
      s.revenueCents += value(r) || 0;
    }
  }
  return out;
}

promotions.get("/account/providers/:id/promotions", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  const { owner } = await runsBusiness(user, providerId);
  const s = await settings();
  const { data: rows, error } = await db().from("provider_promotions")
    .select("id,kind,placement,plan_id,starts_at,ends_at,price_cents,extra_commission_pct,status,created_at")
    .eq("provider_id", providerId).order("created_at", { ascending: false }).limit(50);
  if (error) {
    if (/provider_promotions|does not exist/i.test(error.message)) {
      return c.json({ enabled: false, canBuy: owner, settings: s, boost: null, promotions: [], availableCents: 0, slotsLeft: { home: 0, service: 0 } });
    }
    throw new HttpError(503, "Could not read your promotions.");
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stats = await statsFor((rows ?? []).map((r) => r.id), since);
  const boost = (rows ?? []).find((r) => r.kind === "boost") ?? null;
  let availableCents = 0;
  if (owner) { try { availableCents = (await summarize(providerId)).availableCents; } catch { availableCents = 0; } }
  const { data: prov } = await db().from("providers").select("archetype_key").eq("id", providerId).maybeSingle();
  return c.json({
    enabled: true,
    canBuy: owner,
    settings: s,
    availableCents,
    slotsLeft: {
      home: Math.max(0, s.slotsHome - await liveFeaturedCount("home", null, new Date(), new Date(Date.now() + WEEK_MS))),
      service: Math.max(0, s.slotsService - await liveFeaturedCount("service", prov?.archetype_key ?? null, new Date(), new Date(Date.now() + WEEK_MS))),
    },
    boost: boost ? { ...boost, stats: stats.get(boost.id) } : null,
    promotions: (rows ?? []).filter((r) => r.kind === "featured").map((r) => ({ ...r, stats: stats.get(r.id) })),
  });
});

/** Boost on/off. Owner only — it changes what the business pays. */
promotions.post("/account/providers/:id/promotions/boost", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  const { owner } = await runsBusiness(user, providerId);
  if (!owner) throw forbidden("Only the owner can change what the business pays.");
  const b = await c.req.json().catch(() => ({})) as { on?: unknown; planId?: unknown };
  const on = b.on === true;
  const planId = typeof b.planId === "string" && UUID_RE.test(b.planId) ? b.planId : null;
  if (planId) await assertOwnPlan(providerId, planId);
  const s = await settings();

  const { data: existing } = await db().from("provider_promotions").select("id").eq("provider_id", providerId).eq("kind", "boost").maybeSingle();
  if (existing) {
    const patch: Record<string, unknown> = { status: on ? "active" : "paused", updated_at: new Date().toISOString(), plan_id: planId };
    // The rate is the one shown when it was switched ON; switching on again takes today's.
    if (on) patch.extra_commission_pct = s.boostPct;
    const { error } = await db().from("provider_promotions").update(patch).eq("id", existing.id);
    if (error) throw new HttpError(503, "Could not change the boost.");
  } else if (on) {
    const { error } = await db().from("provider_promotions").insert({
      provider_id: providerId, plan_id: planId, kind: "boost", extra_commission_pct: s.boostPct, status: "active", created_by: user.id,
    });
    if (error) throw new HttpError(503, /provider_promotions/.test(error.message) ? "Promotion isn't switched on yet." : "Could not switch the boost on.");
  }
  return c.json({ ok: true, on, extraPct: s.boostPct });
});

async function assertOwnPlan(providerId: string, planId: string) {
  const { data } = await db().from("provider_plans").select("id,provider_id,status").eq("id", planId).maybeSingle();
  if (!data || String(data.provider_id) !== providerId) throw badRequest("That offer isn't yours.");
  if (data.status !== "active") throw badRequest("That offer isn't on sale.");
}

/** Featured slots that overlap [from, to) for a placement (and service). */
async function liveFeaturedCount(placement: Placement, archetype: string | null, from: Date, to: Date, exceptId?: string): Promise<number> {
  let q = db().from("provider_promotions").select("id,providers!inner(archetype_key)")
    .eq("kind", "featured").eq("placement", placement).eq("status", "active")
    .lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString());
  if (placement === "service" && archetype) q = q.eq("providers.archetype_key", archetype);
  if (exceptId) q = q.neq("id", exceptId);
  const { data } = await q;
  return data?.length ?? 0;
}

/** Buy a featured slot, paid from what the business has earned. Owner only. */
promotions.post("/account/providers/:id/promotions/featured", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  const { owner } = await runsBusiness(user, providerId);
  if (!owner) throw forbidden("Only the owner can spend the business's balance.");
  const b = await c.req.json().catch(() => ({})) as { placement?: unknown; weeks?: unknown; planId?: unknown };
  const placement: Placement = b.placement === "home" ? "home" : b.placement === "service" ? "service" : (() => { throw badRequest("Pick where to be featured."); })();
  const weeks = Number(b.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 4) throw badRequest("Between 1 and 4 weeks.");
  const planId = typeof b.planId === "string" && UUID_RE.test(b.planId) ? b.planId : null;
  if (planId) await assertOwnPlan(providerId, planId);

  const { data: prov } = await db().from("providers").select("name,status,archetype_key").eq("id", providerId).maybeSingle();
  if (!prov) throw notFound("Business not found.");
  if (prov.status !== "active" && prov.status !== "approved") throw badRequest("Go live first — a featured slot sends people to your page.");

  const s = await settings();
  const capacity = placement === "home" ? s.slotsHome : s.slotsService;
  const price = (placement === "home" ? s.homeWeekCents : s.serviceWeekCents) * weeks;
  if (price <= 0) throw badRequest("Featured slots aren't priced yet.");
  const from = new Date();
  const to = new Date(from.getTime() + weeks * WEEK_MS);

  if (await liveFeaturedCount(placement, prov.archetype_key, from, to) >= capacity) {
    throw new HttpError(409, "Every slot there is taken for those dates. Try the other placement, or fewer weeks.");
  }
  const summary = await summarize(providerId);
  if (summary.availableCents < price) {
    throw new HttpError(402, `That costs ${usd(price)}; your balance is ${usd(summary.availableCents)}. It's paid from what you've earned.`);
  }

  // Claim the money first (a committed payout row), then the slot, then check
  // nobody got there in between — the same claim-then-verify as withdrawals.
  const label = placement === "home" ? "Home" : "Service listing";
  const { data: payout, error: payErr } = await db().from("provider_payouts").insert({
    provider_id: providerId, amount_cents: price, currency: "USD", method: "promotion", status: "paid",
    reference: `Featured · ${label} · ${weeks} wk`, note: "Paid from balance for a featured placement",
    paid_at: from.toISOString(), created_by: user.id, requested_by: user.id, requested_at: from.toISOString(),
  }).select("id").single();
  if (payErr || !payout) throw new HttpError(503, "Could not take the payment from your balance.");

  const { data: promo, error: promoErr } = await db().from("provider_promotions").insert({
    provider_id: providerId, plan_id: planId, kind: "featured", placement,
    starts_at: from.toISOString(), ends_at: to.toISOString(), price_cents: price, status: "active",
    payout_id: payout.id, created_by: user.id,
  }).select("id").single();

  const undo = async (msg: string, status = 409) => {
    if (promo?.id) await db().from("provider_promotions").delete().eq("id", promo.id);
    await db().from("provider_payouts").delete().eq("id", payout.id);
    throw new HttpError(status, msg);
  };
  if (promoErr || !promo) return await undo("Could not book the slot.", 503);
  const after = await summarize(providerId);
  if (after.committedCents > after.earnedCents) return await undo("Your balance changed while booking. Nothing was charged — try again.");
  if (await liveFeaturedCount(placement, prov.archetype_key, from, to, promo.id) >= capacity) {
    return await undo("Someone booked the last slot a moment ago. Nothing was charged.");
  }

  const admins = await superAdminIds();
  await Promise.all(admins.map((id) => notifyUser({
    recipientUserId: id, category: "business", type: "promotion_bought",
    title: `${prov.name} bought a featured slot`,
    body: `${label} · ${weeks} week${weeks > 1 ? "s" : ""} · ${usd(price)} from their balance.`,
    relatedEntityType: "provider_promotion", relatedEntityId: promo.id, actionUrl: "/admin/promotions",
  }).catch(() => undefined)));
  return c.json({ ok: true, id: promo.id, priceCents: price, endsAt: to.toISOString() }, 201);
});

// ── Admin ────────────────────────────────────────────────────────────────────

promotions.get("/admin/promotions", async (c) => {
  await requireAdmin(c, "payments.read");
  const s = await settings();
  const { data, error } = await db().from("provider_promotions")
    .select("id,kind,placement,plan_id,provider_id,starts_at,ends_at,price_cents,extra_commission_pct,status,created_at,providers(name)")
    .order("created_at", { ascending: false }).limit(200);
  if (error) {
    if (/provider_promotions|does not exist/i.test(error.message)) return c.json({ enabled: false, settings: s, rows: [] });
    throw new HttpError(503, "Could not read promotions.");
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stats = await statsFor((data ?? []).map((r) => r.id), since);
  return c.json({
    enabled: true, settings: s,
    rows: (data ?? []).map((r: any) => ({ ...r, providerName: r.providers?.name ?? "—", providers: undefined, stats: stats.get(r.id) })),
  });
});

/**
 * A featured slot GIVEN by the platform — free: no payout row, price 0, the
 * same provider_promotions row a purchase makes, so the rails, the slot
 * limits, the stats and "End" all treat it the same. For launching a new
 * business, a partner, a test. The business is told it was featured.
 */
promotions.post("/admin/promotions/grant", async (c) => {
  const admin = await requireAdmin(c, "payments.read");
  const b = await c.req.json().catch(() => ({})) as { providerId?: unknown; planId?: unknown; placement?: unknown; weeks?: unknown };
  const providerId = String(b.providerId ?? "");
  if (!UUID_RE.test(providerId)) throw badRequest("Pick a business.");
  const placement: Placement = b.placement === "home" ? "home" : b.placement === "service" ? "service" : (() => { throw badRequest("Pick where to feature it."); })();
  const weeks = Number(b.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw badRequest("Between 1 and 12 weeks.");
  const planId = typeof b.planId === "string" && UUID_RE.test(b.planId) ? b.planId : null;
  if (planId) await assertOwnPlan(providerId, planId);

  const { data: prov } = await db().from("providers").select("name,status,archetype_key,admin_user_id").eq("id", providerId).maybeSingle();
  if (!prov) throw notFound("Business not found.");
  if (prov.status !== "active" && prov.status !== "approved") throw badRequest("That business isn't live — a featured slot would send people to a closed page.");
  if (placement === "service" && !prov.archetype_key) throw badRequest("That business has no service listing to be featured in — use Home.");

  const s = await settings();
  const capacity = placement === "home" ? s.slotsHome : s.slotsService;
  const from = new Date();
  const to = new Date(from.getTime() + weeks * WEEK_MS);
  if (await liveFeaturedCount(placement, prov.archetype_key, from, to) >= capacity) {
    throw new HttpError(409, `All ${capacity} ${placement === "home" ? "home" : "service"} slots are taken for those dates. End one, or raise the slot count below.`);
  }

  const { data: promo, error } = await db().from("provider_promotions").insert({
    provider_id: providerId, plan_id: planId, kind: "featured", placement,
    starts_at: from.toISOString(), ends_at: to.toISOString(), price_cents: 0, status: "active",
    payout_id: null, created_by: admin.id,
  }).select("id").single();
  if (error || !promo) throw new HttpError(503, "Could not give the slot.");

  if (prov.admin_user_id) {
    await notifyUser({
      recipientUserId: String(prov.admin_user_id), category: "business", type: "promotion_granted",
      title: "You're featured on EverySub",
      body: `${placement === "home" ? "On the home page" : "At the top of your service"} for ${weeks} week${weeks > 1 ? "s" : ""}, on us.`,
      relatedEntityType: "provider_promotion", relatedEntityId: promo.id,
    }).catch(() => undefined);
  }
  return c.json({ ok: true, id: promo.id, endsAt: to.toISOString() }, 201);
});

promotions.post("/admin/promotions/:promoId/end", async (c) => {
  await requireAdmin(c, "payments.read");
  const id = c.req.param("promoId");
  if (!UUID_RE.test(id)) throw notFound("Promotion not found.");
  const { data, error } = await db().from("provider_promotions")
    .update({ status: "ended", ends_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).select("id");
  if (error) throw new HttpError(503, "Could not end it.");
  if (!data?.length) throw notFound("Promotion not found.");
  return c.json({ ok: true });
});

promotions.put("/admin/promotions/settings", async (c) => {
  await requireAdmin(c, "payments.read");
  const b = await c.req.json().catch(() => ({})) as Partial<Record<keyof PromoSettings, unknown>>;
  for (const [field, [key]] of Object.entries(SETTING_KEYS)) {
    const v = (b as any)[field];
    if (v === undefined) continue;
    const n = Number(v);
    const max = field === "boostPct" ? 50 : field.startsWith("slots") ? 12 : 1_000_000;
    if (!Number.isFinite(n) || n < 0 || n > max) throw badRequest(`${field} is out of range.`);
    const value = field.startsWith("slots") || field.endsWith("Cents") ? Math.round(n) : n;
    const { data: row } = await db().from("global_settings").select("id").eq("key", key).maybeSingle();
    const { error } = row
      ? await db().from("global_settings").update({ value, updated_at: new Date().toISOString() }).eq("key", key)
      : await db().from("global_settings").insert({ id: crypto.randomUUID(), key, value });
    if (error) throw new HttpError(503, "Could not save the settings.");
  }
  return c.json({ ok: true, settings: await settings() });
});
