import { Hono } from "hono";
import { type AuthUser, requireAccount, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";

/**
 * A business's own discounts (provider_discounts) and the platform campaigns it
 * can join — the only write path to either table.
 *
 * What a discount is WORTH is never decided here: the database function
 * `discount_quote` prices it at checkout and the order trigger prices it again.
 * This file only checks that what a business asks for is a sane shape, within
 * the platform's limits, and on its own offers.
 *
 * Owner only, like promo codes: a discount is the business's money.
 */
export const discounts = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");
/** The marketplace's own clock (Honduras, UTC−6): "until Dec 1" means the end of Dec 1 there. */
const dayStart = (d: string) => `${d}T00:00:00-06:00`;
const dayEnd = (d: string) => `${d}T23:59:59-06:00`;

const SETTING_KEYS = { maxPct: ["discount_max_pct", 70], maxLive: ["discount_max_live", 5] } as const;
type Settings = { maxPct: number; maxLive: number };

async function settings(): Promise<Settings> {
  const { data } = await db().from("global_settings").select("key,value")
    .in("key", Object.values(SETTING_KEYS).map(([k]) => k));
  const byKey = new Map((data ?? []).map((r) => [r.key, Number(r.value)]));
  const out = {} as Settings;
  for (const [field, [key, fallback]] of Object.entries(SETTING_KEYS)) {
    const v = byKey.get(key);
    (out as Record<string, number>)[field] = Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback;
  }
  return out;
}

async function assertOwner(user: AuthUser, providerId: string) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  const { data: p } = await db().from("providers").select("id,admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (isSuperAdmin(user.roles)) return;
  if (!p.admin_user_id || String(p.admin_user_id) !== String(user.id)) {
    throw forbidden("Only the owner of this business can set discounts.");
  }
}

const SELECT = "id,provider_id,campaign_id,kind,title,value_type,percent_off,amount_off_cents,tiers,intro_periods,target_ids,min_order_cents,max_redemptions,starts_at,ends_at,status,admin_hidden,admin_note,platform_share_pct,created_at";

/** "live" | "scheduled" | "paused" | "ended" — what the list groups by. */
function stateOf(d: Record<string, any>, now = Date.now()): string {
  if (d.status === "ended" || (d.ends_at && Date.parse(d.ends_at) <= now)) return "ended";
  if (d.admin_hidden) return "hidden";
  if (d.status === "paused") return "paused";
  if (Date.parse(d.starts_at) > now) return "scheduled";
  return "live";
}

/** Orders, revenue after discount, what the discount cost and how many were new customers. */
async function statsFor(ids: string[]) {
  const out = new Map<string, { orders: number; revenueCents: number; discountCents: number; newCustomers: number }>();
  if (!ids.length) return out;
  const { data } = await db().from("discount_redemptions")
    .select("discount_id,discount_cents,revenue_cents,new_customer").in("discount_id", ids).limit(5000);
  for (const r of data ?? []) {
    const s = out.get(r.discount_id) ?? { orders: 0, revenueCents: 0, discountCents: 0, newCustomers: 0 };
    s.orders += 1;
    s.revenueCents += Number(r.revenue_cents) || 0;
    s.discountCents += Number(r.discount_cents) || 0;
    if (r.new_customer) s.newCustomers += 1;
    out.set(r.discount_id, s);
  }
  return out;
}

/** What this business sells, for the "which offers" picker and the preview. */
async function catalogOf(providerId: string) {
  const [{ data: plans }, { data: vehicles }] = await Promise.all([
    db().from("provider_plans")
      .select("id,name,price_cents,period,pricing_mode,parent_plan_id,status,sort_order")
      .eq("provider_id", providerId).neq("status", "archived").order("sort_order").limit(200),
    db().from("rental_vehicles")
      .select("id,name,brand,model,daily_price_cents,status,image_url")
      .eq("provider_id", providerId).neq("status", "archived").order("sort_order").limit(200),
  ]);
  return {
    plans: (plans ?? []).map((p) => ({
      id: p.id, name: p.name, priceCents: Number(p.price_cents) || 0, period: p.period,
      perPerson: p.pricing_mode === "per_person", parentId: p.parent_plan_id, status: p.status,
    })),
    vehicles: (vehicles ?? []).map((v) => ({
      id: v.id, name: v.name || [v.brand, v.model].filter(Boolean).join(" ") || "Vehicle",
      dailyPriceCents: Number(v.daily_price_cents) || 0, status: v.status, imageUrl: v.image_url,
    })),
  };
}

interface Draft {
  kind: "sale" | "intro" | "prepay";
  title: string | null;
  value_type: "percent" | "fixed";
  percent_off: number | null;
  amount_off_cents: number | null;
  tiers: Array<{ periods: number; percent_off: number }> | null;
  intro_periods: number;
  target_ids: string[] | null;
  min_order_cents: number;
  max_redemptions: number | null;
  starts_at: string;
  ends_at: string | null;
}

/** Validate a business's request into a row. Every limit the form shows is enforced here again. */
function parseDraft(b: Record<string, unknown>, s: Settings, allowed: Set<string>): Draft {
  const kind = b.kind;
  if (kind !== "sale" && kind !== "intro" && kind !== "prepay") throw badRequest("Pick a type: sale, new customers or prepay.");
  const valueType = b.valueType === "fixed" && kind !== "prepay" ? "fixed" : "percent";
  const pct = Math.round(Number(b.percentOff));
  const amount = Math.round(Number(b.amountOff) * 100);
  let tiers: Draft["tiers"] = null;
  if (kind === "prepay") {
    const raw = Array.isArray(b.tiers) ? b.tiers : [];
    tiers = raw.map((t: any) => ({ periods: Math.round(Number(t?.periods)), percent_off: Math.round(Number(t?.percentOff ?? t?.percent_off)) }))
      .filter((t) => t.periods >= 2 && t.periods <= 24 && t.percent_off >= 1)
      .sort((a, b) => a.periods - b.periods);
    if (!tiers.length) throw badRequest("Add at least one step, e.g. 3 months → 10% off.");
    if (tiers.length > 4) throw badRequest("Up to four steps.");
    if (new Set(tiers.map((t) => t.periods)).size !== tiers.length) throw badRequest("Each step needs a different length.");
    for (const t of tiers) {
      if (t.percent_off > s.maxPct) throw badRequest(`A discount is at most ${s.maxPct}%.`);
    }
  } else if (valueType === "percent") {
    if (!(pct >= 1 && pct <= s.maxPct)) throw badRequest(`A percentage is between 1 and ${s.maxPct}.`);
  } else if (!(amount >= 100 && amount <= 1_000_000)) {
    throw badRequest("An amount off is between $1 and $10,000.");
  }

  let target: string[] | null = null;
  if (Array.isArray(b.targetIds) && b.targetIds.length) {
    target = [...new Set(b.targetIds.map(String))];
    if (target.some((id) => !allowed.has(id))) throw badRequest("One of the offers is not yours.");
  }

  const today = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
  const startDay = typeof b.startsOn === "string" && DAY_RE.test(b.startsOn) ? b.startsOn : null;
  const endDay = typeof b.endsOn === "string" && DAY_RE.test(b.endsOn) ? b.endsOn : null;
  const startsAt = startDay && startDay > today ? dayStart(startDay) : new Date().toISOString();
  const endsAt = endDay ? dayEnd(endDay) : null;
  if (endDay && endDay < today) throw badRequest("The end date has already passed.");
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw badRequest("The end must be after the start.");
  if (kind === "sale" && !endsAt) {
    // A sale with no end is just a lower price: change the price instead.
    throw badRequest("A sale needs an end date — for a permanent change, edit the price.");
  }

  const maxRed = Number(b.maxRedemptions);
  const minOrder = Math.round(Number(b.minOrder ?? 0) * 100);
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 80) || null : null;
  return {
    kind,
    title,
    value_type: valueType,
    percent_off: kind === "prepay" ? null : valueType === "percent" ? pct : null,
    amount_off_cents: kind === "prepay" ? null : valueType === "fixed" ? amount : null,
    tiers,
    intro_periods: kind === "intro" ? Math.min(12, Math.max(1, Math.round(Number(b.introPeriods) || 1))) : 1,
    target_ids: target,
    min_order_cents: Number.isFinite(minOrder) && minOrder > 0 ? minOrder : 0,
    max_redemptions: Number.isInteger(maxRed) && maxRed > 0 ? maxRed : null,
    starts_at: startsAt,
    ends_at: endsAt,
  };
}

async function liveCount(providerId: string): Promise<number> {
  const { data } = await db().from("provider_discounts").select("id,status,starts_at,ends_at,admin_hidden")
    .eq("provider_id", providerId).neq("status", "ended");
  return (data ?? []).filter((d) => ["live", "scheduled", "paused"].includes(stateOf(d))).length;
}

/**
 * Tell the people who would care: those who saved this business or one of its
 * offers, and recent customers whose subscription ran out. At most one such
 * message per person per business per week; best-effort, never blocks.
 */
async function announce(providerId: string, d: Draft & { id: string }) {
  try {
    const { data: prov } = await db().from("providers").select("name,slug,status").eq("id", providerId).maybeSingle();
    if (!prov || (prov.status && !["active", "live", "published"].includes(String(prov.status)))) return;
    const { data: plans } = await db().from("provider_plans").select("id").eq("provider_id", providerId).limit(200);
    const planIds = (plans ?? []).map((p) => String(p.id));
    const people = new Set<string>();
    const { data: favs } = await db().from("favorites").select("user_id,kind,target_id")
      .or(`and(kind.eq.provider,target_id.eq.${providerId})${planIds.length ? `,and(kind.eq.plan,target_id.in.(${planIds.join(",")}))` : ""}`)
      .limit(1000);
    for (const f of favs ?? []) people.add(String(f.user_id));
    // Lapsed customers of the last 90 days (universal plans; legacy tables keep their own reminders).
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const { data: lapsed } = await db().from("provider_subscriptions").select("user_id,status,end_date")
      .eq("provider_id", providerId).eq("payment_status", "paid").gte("end_date", since)
      .lt("end_date", new Date().toISOString().slice(0, 10)).limit(1000);
    const { data: active } = await db().from("provider_subscriptions").select("user_id")
      .eq("provider_id", providerId).eq("payment_status", "paid")
      .gte("end_date", new Date().toISOString().slice(0, 10)).limit(2000);
    const stillIn = new Set((active ?? []).map((r) => String(r.user_id)));
    for (const r of lapsed ?? []) if (r.user_id && !stillIn.has(String(r.user_id))) people.add(String(r.user_id));
    if (d.kind === "intro") for (const r of active ?? []) people.delete(String(r.user_id));
    if (!people.size) return;

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: recent } = await db().from("user_notifications").select("recipient_user_id")
      .eq("type", "provider_discount").eq("related_entity_id", providerId).gte("created_at", weekAgo).limit(2000);
    for (const r of recent ?? []) people.delete(String(r.recipient_user_id));

    const what = d.kind === "prepay"
      ? `up to ${Math.max(...(d.tiers ?? []).map((t) => t.percent_off))}% off when you pay ahead`
      : d.value_type === "percent" ? `${d.percent_off}% off` : `$${((d.amount_off_cents ?? 0) / 100).toFixed(0)} off`;
    const until = d.ends_at ? ` until ${new Date(d.ends_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Tegucigalpa" })}` : "";
    const starts = Date.parse(d.starts_at) > Date.now() + 60_000
      ? ` from ${new Date(d.starts_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Tegucigalpa" })}` : "";
    const title = `${prov.name}: ${what}`;
    const body = d.kind === "intro" ? `New customers get ${what} on their first ${d.intro_periods > 1 ? `${d.intro_periods} periods` : "period"}${until}.` : `${d.title ? `${d.title} — ` : ""}${what}${starts}${until}.`;
    const url = `/businesses/${prov.slug || providerId}`;
    await Promise.all([...people].slice(0, 500).map((uid) => notifyUser({
      recipientUserId: uid, category: "offers", type: "provider_discount", title, body,
      relatedEntityType: "provider", relatedEntityId: providerId, actionUrl: url,
      metadata: { discount_id: d.id },
    })));
  } catch (e) {
    console.warn("[discounts] announce failed", (e as Error).message);
  }
}

// ── Business ─────────────────────────────────────────────────────────────────

discounts.get("/account/providers/:id/discounts", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user, providerId);
  const [s, catalog, { data: rows, error }, { data: prov }, { data: camps }] = await Promise.all([
    settings(),
    catalogOf(providerId),
    db().from("provider_discounts").select(SELECT).eq("provider_id", providerId).order("created_at", { ascending: false }).limit(200),
    db().from("providers").select("commission_pct").eq("id", providerId).maybeSingle(),
    db().from("discount_campaigns").select("id,title,description,min_percent_off,platform_share_pct,starts_at,ends_at,status")
      .eq("status", "active").gt("ends_at", new Date().toISOString()).order("starts_at"),
  ]);
  if (error) throw new HttpError(503, "Could not read your discounts.");
  const stats = await statsFor((rows ?? []).map((r) => r.id));
  const { data: fallback } = await db().from("global_settings").select("value").eq("key", "finance_default_commission_pct").maybeSingle();
  const commissionPct = prov?.commission_pct != null ? Number(prov.commission_pct) : Number(fallback?.value ?? 10) || 10;
  const joined = new Set((rows ?? []).filter((r) => r.campaign_id && r.status !== "ended").map((r) => r.campaign_id));
  return c.json({
    settings: s,
    commissionPct,
    ...catalog,
    discounts: (rows ?? []).map((r) => ({
      ...r, state: stateOf(r), stats: stats.get(r.id) ?? { orders: 0, revenueCents: 0, discountCents: 0, newCustomers: 0 },
    })),
    campaigns: (camps ?? []).map((k) => ({ ...k, joined: joined.has(k.id) })),
  });
});

discounts.post("/account/providers/:id/discounts", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user, providerId);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const s = await settings();
  const catalog = await catalogOf(providerId);
  const allowed = new Set([...catalog.plans.map((p) => p.id), ...catalog.vehicles.map((v) => v.id)]);
  const draft = parseDraft(b, s, allowed);
  if (await liveCount(providerId) >= s.maxLive) {
    throw badRequest(`Up to ${s.maxLive} discounts at a time — end one first.`);
  }
  const { data, error } = await db().from("provider_discounts").insert({
    ...draft, provider_id: providerId, status: "active", created_by: user.id,
  }).select("id").single();
  if (error) throw new HttpError(503, "Could not save the discount.");
  if (b.notify !== false) await announce(providerId, { ...draft, id: data.id });
  return c.json({ id: data.id }, 201);
});

discounts.patch("/account/providers/:id/discounts/:did", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user, providerId);
  const did = c.req.param("did");
  if (!UUID_RE.test(did)) throw notFound("Discount not found.");
  const { data: row } = await db().from("provider_discounts").select(SELECT).eq("id", did).eq("provider_id", providerId).maybeSingle();
  if (!row) throw notFound("Discount not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.status !== undefined) {
    if (!["active", "paused", "ended"].includes(String(b.status))) throw badRequest("status is active, paused or ended.");
    if (row.status === "ended") throw badRequest("An ended discount stays ended — duplicate it instead.");
    if (b.status === "active" && row.status === "paused" && (await liveCount(providerId)) > (await settings()).maxLive) {
      throw badRequest("Too many discounts at once — end one first.");
    }
    patch.status = b.status;
  }
  if (typeof b.endsOn === "string" && DAY_RE.test(b.endsOn)) {
    const end = dayEnd(b.endsOn);
    if (Date.parse(end) <= Math.max(Date.now(), Date.parse(row.starts_at))) throw badRequest("Pick an end date in the future.");
    patch.ends_at = end;
  }
  if (typeof b.title === "string") patch.title = b.title.trim().slice(0, 80) || null;
  const { error } = await db().from("provider_discounts").update(patch).eq("id", did).eq("provider_id", providerId);
  if (error) throw new HttpError(503, "Could not update the discount.");
  return c.json({ ok: true });
});

/** Join a platform campaign: a sale with the campaign's dates; the platform pays its share. */
discounts.post("/account/providers/:id/discounts/campaigns/:cid/join", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user, providerId);
  const cid = c.req.param("cid");
  if (!UUID_RE.test(cid)) throw notFound("Campaign not found.");
  const { data: k } = await db().from("discount_campaigns").select("*").eq("id", cid).eq("status", "active").maybeSingle();
  if (!k || Date.parse(k.ends_at) <= Date.now()) throw notFound("That campaign is over.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const s = await settings();
  const pct = Math.round(Number(b.percentOff ?? k.min_percent_off));
  if (!(pct >= k.min_percent_off && pct <= s.maxPct)) throw badRequest(`This campaign needs ${k.min_percent_off}–${s.maxPct}% off.`);
  const catalog = await catalogOf(providerId);
  const allowed = new Set([...catalog.plans.map((p) => p.id), ...catalog.vehicles.map((v) => v.id)]);
  const target = Array.isArray(b.targetIds) && b.targetIds.length ? [...new Set(b.targetIds.map(String))] : null;
  if (target?.some((id) => !allowed.has(id))) throw badRequest("One of the offers is not yours.");
  const row = {
    provider_id: providerId, campaign_id: cid, kind: "sale" as const, title: k.title, value_type: "percent" as const,
    percent_off: pct, amount_off_cents: null, tiers: null, intro_periods: 1, target_ids: target,
    min_order_cents: 0, max_redemptions: null,
    starts_at: Date.parse(k.starts_at) > Date.now() ? k.starts_at : new Date().toISOString(), ends_at: k.ends_at,
    status: "active", platform_share_pct: k.platform_share_pct, created_by: user.id,
  };
  const { data, error } = await db().from("provider_discounts").insert(row).select("id").single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new HttpError(409, "You are already in this campaign.");
    throw new HttpError(503, "Could not join the campaign.");
  }
  await announce(providerId, { ...row, id: data.id });
  return c.json({ id: data.id }, 201);
});

// ── Admin ────────────────────────────────────────────────────────────────────

discounts.get("/admin/discounts", async (c) => {
  await requireAdmin(c, "payments.read");
  const [s, { data: rows, error }, { data: camps }] = await Promise.all([
    settings(),
    db().from("provider_discounts").select(`${SELECT},providers(name)`).order("created_at", { ascending: false }).limit(500),
    db().from("discount_campaigns").select("*").order("starts_at", { ascending: false }).limit(50),
  ]);
  if (error) {
    if (/provider_discounts|does not exist/i.test(error.message)) return c.json({ enabled: false, settings: s, discounts: [], campaigns: [], totals: null });
    throw new HttpError(503, "Could not read discounts.");
  }
  const stats = await statsFor((rows ?? []).map((r) => r.id));
  // Who paid for reductions over the last 30 days, across every order table.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let business = 0, platform = 0;
  for (const t of ["provider_subscriptions", "food_subscriptions", "cleaning_subscriptions", "rental_bookings"]) {
    const { data } = await db().from(t).select("offer_discount_cents,promo_discount_cents,provider_discount_cents")
      .eq("payment_status", "paid").gte("created_at", since).or("offer_discount_cents.gt.0,promo_discount_cents.gt.0").limit(5000);
    for (const r of data ?? []) {
      const all = (Number(r.offer_discount_cents) || 0) + (Number(r.promo_discount_cents) || 0);
      const own = Math.min(all, Number(r.provider_discount_cents) || 0);
      business += own;
      platform += all - own;
    }
  }
  return c.json({
    enabled: true,
    settings: s,
    totals: { businessCents: business, platformCents: platform, since },
    discounts: (rows ?? []).map((r: any) => ({
      ...r, providerName: r.providers?.name ?? null, providers: undefined, state: stateOf(r),
      stats: stats.get(r.id) ?? { orders: 0, revenueCents: 0, discountCents: 0, newCustomers: 0 },
    })),
    campaigns: camps ?? [],
  });
});

discounts.patch("/admin/discounts/:did", async (c) => {
  await requireAdmin(c, "payments.read");
  const did = c.req.param("did");
  if (!UUID_RE.test(did)) throw notFound("Discount not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof b.hidden === "boolean") patch.admin_hidden = b.hidden;
  if (typeof b.note === "string") patch.admin_note = b.note.trim().slice(0, 300) || null;
  if (b.status === "ended") patch.status = "ended";
  const { data, error } = await db().from("provider_discounts").update(patch).eq("id", did).select("id");
  if (error) throw new HttpError(503, "Could not update the discount.");
  if (!data?.length) throw notFound("Discount not found.");
  return c.json({ ok: true });
});

discounts.put("/admin/discounts/settings", async (c) => {
  await requireAdmin(c, "payments.read");
  const b = await c.req.json().catch(() => ({})) as Partial<Record<keyof Settings, unknown>>;
  for (const [field, [key]] of Object.entries(SETTING_KEYS)) {
    const v = (b as Record<string, unknown>)[field];
    if (v === undefined) continue;
    const n = Math.round(Number(v));
    const max = field === "maxPct" ? 90 : 20;
    if (!Number.isFinite(n) || n < 1 || n > max) throw badRequest(`${field} is between 1 and ${max}.`);
    const { data: row } = await db().from("global_settings").select("id").eq("key", key).maybeSingle();
    const { error } = row
      ? await db().from("global_settings").update({ value: n, updated_at: new Date().toISOString() }).eq("key", key)
      : await db().from("global_settings").insert({ id: crypto.randomUUID(), key, value: n });
    if (error) throw new HttpError(503, "Could not save the settings.");
  }
  return c.json({ ok: true, settings: await settings() });
});

discounts.post("/admin/discount-campaigns", async (c) => {
  const admin = await requireAdmin(c, "payments.read");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const title = String(b.title ?? "").trim();
  if (title.length < 2 || title.length > 80) throw badRequest("A title is 2–80 characters.");
  const startDay = typeof b.startsOn === "string" && DAY_RE.test(b.startsOn) ? b.startsOn : null;
  const endDay = typeof b.endsOn === "string" && DAY_RE.test(b.endsOn) ? b.endsOn : null;
  if (!startDay || !endDay || endDay < startDay) throw badRequest("Pick a start and an end date.");
  const minPct = Math.round(Number(b.minPercentOff ?? 10));
  const share = Math.round(Number(b.platformSharePct ?? 0));
  if (!(minPct >= 1 && minPct <= 90)) throw badRequest("The minimum discount is 1–90%.");
  if (!(share >= 0 && share <= 100)) throw badRequest("The platform's share is 0–100%.");
  const { data, error } = await db().from("discount_campaigns").insert({
    title, description: typeof b.description === "string" ? b.description.trim().slice(0, 400) || null : null,
    min_percent_off: minPct, platform_share_pct: share,
    starts_at: dayStart(startDay), ends_at: dayEnd(endDay), status: "active", created_by: admin.id,
  }).select("id").single();
  if (error) throw new HttpError(503, "Could not create the campaign.");
  return c.json({ id: data.id }, 201);
});

discounts.patch("/admin/discount-campaigns/:cid", async (c) => {
  await requireAdmin(c, "payments.read");
  const cid = c.req.param("cid");
  if (!UUID_RE.test(cid)) throw notFound("Campaign not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (b.status !== "ended") throw badRequest("Only ending a campaign is supported.");
  const now = new Date().toISOString();
  const { error } = await db().from("discount_campaigns").update({ status: "ended", updated_at: now }).eq("id", cid);
  if (error) throw new HttpError(503, "Could not end the campaign.");
  // The sales that joined it end with it.
  await db().from("provider_discounts").update({ status: "ended", updated_at: now })
    .eq("campaign_id", cid).neq("status", "ended");
  return c.json({ ok: true });
});
