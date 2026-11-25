import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";

/**
 * "How it works", written by the business.
 *
 * The steps are public copy, so the site reads them straight from
 * `provider_how_it_works` with the public key. Writing is here: the table has
 * no write policy, and this checks that the caller owns the business, is on
 * its team, or is a platform admin.
 *
 *   PUT    /account/providers/:id/how-it-works          { planId?, steps }
 *   DELETE /account/providers/:id/how-it-works?planId=  back to the default
 *
 * planId absent / null = the steps for the whole business; a plan id = that
 * plan's own steps, shown on its page ahead of the business's.
 */
export const howItWorks = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

/** Same keys as HOW_IT_WORKS_ICONS in the front end (src/lib/howItWorks.ts). */
export const ICON_KEYS = new Set([
  "search", "sliders", "card", "repeat", "calendar", "clock", "check", "star", "truck", "utensils",
  "sparkles", "qr", "bell", "chat", "home", "car", "key", "heart", "gift", "map", "phone", "dumbbell", "shield", "smile",
]);

export const LIMITS = { minSteps: 2, maxSteps: 6, title: 60, text: 240 } as const;

export interface Step { title: string; text: string | null; icon: string | null }

/** The steps as sent, cleaned up — or a 400 that says what is wrong, in words. */
export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) throw badRequest("Send the steps as a list.");
  if (raw.length < LIMITS.minSteps || raw.length > LIMITS.maxSteps) {
    throw badRequest(`Between ${LIMITS.minSteps} and ${LIMITS.maxSteps} steps.`);
  }
  return raw.map((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw badRequest(`Step ${n} is not a step.`);
    const o = s as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["title", "text", "icon"].includes(k)) throw badRequest(`Step ${n}: unknown field ${k}.`);
    const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
    if (!title) throw badRequest(`Step ${n} needs a title.`);
    if (title.length > LIMITS.title) throw badRequest(`Step ${n}: the title is longer than ${LIMITS.title} characters.`);
    if (o.text != null && typeof o.text !== "string") throw badRequest(`Step ${n}: the text must be words.`);
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (text.length > LIMITS.text) throw badRequest(`Step ${n}: the text is longer than ${LIMITS.text} characters.`);
    if (o.icon != null && (typeof o.icon !== "string" || (o.icon !== "" && !ICON_KEYS.has(o.icon)))) {
      throw badRequest(`Step ${n}: unknown icon.`);
    }
    return { title, text: text || null, icon: typeof o.icon === "string" && o.icon ? o.icon : null };
  });
}

async function assertRuns(userId: string, providerId: string, roles: string[]) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (isSuperAdmin(roles)) return;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (p.admin_user_id && String(p.admin_user_id) === String(userId)) return;
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  if (!m?.length) throw forbidden("You don't run this business.");
}

/** A plan id, checked to be one of this business's plans; null = whole business. */
async function planOf(providerId: string, raw: unknown): Promise<string | null> {
  if (raw == null || raw === "") return null;
  const planId = String(raw);
  if (!UUID_RE.test(planId)) throw badRequest("Unknown plan.");
  const { data } = await db().from("provider_plans").select("id").eq("id", planId).eq("provider_id", providerId).maybeSingle();
  if (!data) throw notFound("That plan is not one of this business's.");
  return planId;
}

const notReady = (msg: string) =>
  /provider_how_it_works/.test(msg) ? new HttpError(503, "Editing “How it works” isn't switched on yet.") : null;

howItWorks.put("/account/providers/:id/how-it-works", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const b = await c.req.json().catch(() => ({})) as { planId?: unknown; steps?: unknown };
  const planId = await planOf(providerId, b.planId);
  const steps = parseSteps(b.steps);

  const row = { provider_id: providerId, plan_id: planId, steps, updated_by: UUID_RE.test(user.id) ? user.id : null, updated_at: new Date().toISOString() };
  // Two partial unique indexes, so no single ON CONFLICT target: find, then write.
  const q = db().from("provider_how_it_works").select("id").eq("provider_id", providerId);
  const { data: existing, error: readError } = await (planId ? q.eq("plan_id", planId) : q.is("plan_id", null)).maybeSingle();
  if (readError) throw notReady(readError.message) ?? new HttpError(503, "Could not save the steps.");
  const { error } = existing
    ? await db().from("provider_how_it_works").update(row).eq("id", existing.id)
    : await db().from("provider_how_it_works").insert(row);
  if (error) throw notReady(error.message) ?? new HttpError(503, "Could not save the steps.");
  return c.json({ planId, steps, updatedAt: row.updated_at });
});

howItWorks.delete("/account/providers/:id/how-it-works", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const planId = await planOf(providerId, c.req.query("planId"));
  const q = db().from("provider_how_it_works").delete().eq("provider_id", providerId);
  const { error } = await (planId ? q.eq("plan_id", planId) : q.is("plan_id", null));
  if (error) throw notReady(error.message) ?? new HttpError(503, "Could not reset the steps.");
  return c.json({ planId, reset: true });
});
