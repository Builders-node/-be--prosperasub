import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, HttpError, notFound } from "../lib/http.ts";

/**
 * Home collections — shelves of offers an admin curates for the home page.
 *
 *   GET    /admin/collections            → every shelf with its plan ids, inactive too
 *   POST   /admin/collections            {title, subtitle?, isActive?}
 *   PATCH  /admin/collections/:id        {title?, subtitle?, isActive?, sortOrder?, tagKey?}
 *          tagKey: the shelf also fills itself with every live plan carrying
 *          that tag (hand-picked plans first). null turns it off.
 *   DELETE /admin/collections/:id
 *   PUT    /admin/collections/:id/plans  {planIds: string[]}  → replaces the shelf, in that order
 *
 * The home page reads active shelves straight from the tables (public RLS);
 * only writes come through here.
 */
export const collections = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PLANS = 24;
const PERMISSION = "admin_settings.read";

const missing = (msg: string) => /home_collection|does not exist/i.test(msg);

function text(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw badRequest(`${field} is too long.`);
  return s || null;
}

collections.get("/admin/collections", async (c) => {
  await requireAdmin(c, PERMISSION);
  // tag_key arrives with the catalog_tags migration; read without it until then.
  const read = (cols: string) => db().from("home_collections")
    .select(`${cols},home_collection_plans(plan_id,sort_order)`)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  let { data, error } = await read("id,title,subtitle,sort_order,is_active,tag_key");
  const tagsReady = !(error && /tag_key/i.test(error.message));
  if (!tagsReady) ({ data, error } = await read("id,title,subtitle,sort_order,is_active"));
  if (error) {
    if (missing(error.message)) return c.json({ enabled: false, rows: [] });
    throw new HttpError(503, "Could not read collections.");
  }
  return c.json({
    enabled: true,
    tagsReady,
    rows: (data ?? []).map((r: any) => ({
      id: r.id, title: r.title, subtitle: r.subtitle, sortOrder: r.sort_order, isActive: r.is_active,
      tagKey: r.tag_key ?? null,
      planIds: [...(r.home_collection_plans ?? [])]
        .sort((a: any, b: any) => a.sort_order - b.sort_order)
        .map((p: any) => String(p.plan_id)),
    })),
  });
});

collections.post("/admin/collections", async (c) => {
  await requireAdmin(c, PERMISSION);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const title = text(b.title, 80, "Title");
  if (!title) throw badRequest("A collection needs a title.");
  const { data: last } = await db().from("home_collections")
    .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await db().from("home_collections").insert({
    title,
    subtitle: text(b.subtitle, 160, "Subtitle"),
    is_active: b.isActive === undefined ? true : !!b.isActive,
    sort_order: (last?.sort_order ?? -1) + 1,
  }).select("id").single();
  if (error) throw new HttpError(503, "Could not create the collection.");
  return c.json({ ok: true, id: data.id }, 201);
});

collections.patch("/admin/collections/:id", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Collection not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.title !== undefined) {
    const title = text(b.title, 80, "Title");
    if (!title) throw badRequest("A collection needs a title.");
    patch.title = title;
  }
  if (b.subtitle !== undefined) patch.subtitle = text(b.subtitle, 160, "Subtitle");
  if (b.isActive !== undefined) patch.is_active = !!b.isActive;
  if (b.tagKey !== undefined) {
    const k = b.tagKey === null || b.tagKey === "" ? null : String(b.tagKey);
    if (k !== null && !/^[a-z0-9_]{1,40}$/.test(k)) throw badRequest("Bad tag.");
    patch.tag_key = k;
  }
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw badRequest("Bad order.");
    patch.sort_order = n;
  }
  const { data, error } = await db().from("home_collections").update(patch).eq("id", id).select("id");
  if (error) throw new HttpError(503, "Could not save the collection.");
  if (!data?.length) throw notFound("Collection not found.");
  return c.json({ ok: true });
});

collections.delete("/admin/collections/:id", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Collection not found.");
  const { error } = await db().from("home_collections").delete().eq("id", id);
  if (error) throw new HttpError(503, "Could not delete the collection.");
  return c.json({ ok: true });
});

collections.put("/admin/collections/:id/plans", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Collection not found.");
  const b = await c.req.json().catch(() => ({})) as { planIds?: unknown };
  if (!Array.isArray(b.planIds)) throw badRequest("planIds must be a list.");
  const planIds = [...new Set(b.planIds.map(String))];
  if (planIds.length > MAX_PLANS) throw badRequest(`At most ${MAX_PLANS} offers on one shelf.`);
  if (planIds.some((p) => !UUID_RE.test(p))) throw badRequest("Bad plan id.");

  const { data: shelf } = await db().from("home_collections").select("id").eq("id", id).maybeSingle();
  if (!shelf) throw notFound("Collection not found.");
  if (planIds.length) {
    const { data: found } = await db().from("provider_plans").select("id").in("id", planIds);
    if ((found ?? []).length !== planIds.length) throw badRequest("Some of those offers no longer exist.");
  }

  const { error: delErr } = await db().from("home_collection_plans").delete().eq("collection_id", id);
  if (delErr) throw new HttpError(503, "Could not save the offers.");
  if (planIds.length) {
    const { error } = await db().from("home_collection_plans")
      .insert(planIds.map((plan_id, i) => ({ collection_id: id, plan_id, sort_order: i })));
    if (error) throw new HttpError(503, "Could not save the offers.");
  }
  await db().from("home_collections").update({ updated_at: new Date().toISOString() }).eq("id", id);
  return c.json({ ok: true });
});
