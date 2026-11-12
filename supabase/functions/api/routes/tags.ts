import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, HttpError, notFound } from "../lib/http.ts";

/**
 * The tag dictionary, admin side (tables catalog_tag_groups + catalog_tags).
 *
 *   POST  /admin/tags/groups        {label}                       → new group
 *   PATCH /admin/tags/groups/:key   {label?, isActive?, sortOrder?}
 *   POST  /admin/tags               {groupKey, label}             → new tag
 *   PATCH /admin/tags/:key          {label?, isActive?, sortOrder?, groupKey?}
 *
 * Reads are public (RLS) and come straight from the tables. Nothing is ever
 * deleted: plans hold a tag's KEY, so a tag is switched off instead, and its
 * key never changes once made (a rename changes the label only).
 */
export const tags = new Hono();

const PERMISSION = "admin_settings.read";
const KEY_RE = /^[a-z0-9_]{1,40}$/;

function label(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw badRequest("A name is required.");
  if (s.length > 40) throw badRequest("Keep the name under 40 characters.");
  return s;
}

/** "Good for kids" → "good_for_kids", made unique against what exists. */
async function freshKey(table: "catalog_tags" | "catalog_tag_groups", text: string): Promise<string> {
  const base = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 34) || "tag";
  for (let i = 0; i < 50; i++) {
    const key = i ? `${base}_${i + 1}` : base;
    const { data } = await db().from(table).select("key").eq("key", key).maybeSingle();
    if (!data) return key;
  }
  throw new HttpError(409, "Could not find a free key for that name.");
}

const missing = (msg: string) => /catalog_tag|does not exist/i.test(msg);
const fail = (msg: string, what: string) =>
  new HttpError(503, missing(msg) ? "Tags need the database migration (catalog_tags) first." : `Could not ${what}.`);

tags.post("/admin/tags/groups", async (c) => {
  await requireAdmin(c, PERMISSION);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const name = label(b.label);
  const key = await freshKey("catalog_tag_groups", name);
  const { data: last } = await db().from("catalog_tag_groups").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { error } = await db().from("catalog_tag_groups").insert({ key, label: name, sort_order: (last?.sort_order ?? -1) + 1 });
  if (error) throw fail(error.message, "create the group");
  return c.json({ ok: true, key }, 201);
});

tags.patch("/admin/tags/groups/:key", async (c) => {
  await requireAdmin(c, PERMISSION);
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) throw notFound("Group not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.label !== undefined) patch.label = label(b.label);
  if (b.isActive !== undefined) patch.is_active = !!b.isActive;
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw badRequest("Bad order.");
    patch.sort_order = n;
  }
  const { data, error } = await db().from("catalog_tag_groups").update(patch).eq("key", key).select("key");
  if (error) throw fail(error.message, "save the group");
  if (!data?.length) throw notFound("Group not found.");
  return c.json({ ok: true });
});

tags.post("/admin/tags", async (c) => {
  await requireAdmin(c, PERMISSION);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const name = label(b.label);
  const groupKey = String(b.groupKey ?? "");
  if (!KEY_RE.test(groupKey)) throw badRequest("Pick a group.");
  const { data: group } = await db().from("catalog_tag_groups").select("key").eq("key", groupKey).maybeSingle();
  if (!group) throw badRequest("That group does not exist.");
  // The same word twice is how the dictionary turns back into free text.
  const { data: dupe } = await db().from("catalog_tags").select("key").ilike("label", name).maybeSingle();
  if (dupe) throw badRequest(`“${name}” already exists.`);
  const key = await freshKey("catalog_tags", name);
  const { data: last } = await db().from("catalog_tags").select("sort_order").eq("group_key", groupKey)
    .order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { error } = await db().from("catalog_tags").insert({ key, group_key: groupKey, label: name, sort_order: (last?.sort_order ?? -1) + 1 });
  if (error) throw fail(error.message, "create the tag");
  return c.json({ ok: true, key }, 201);
});

tags.patch("/admin/tags/:key", async (c) => {
  await requireAdmin(c, PERMISSION);
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) throw notFound("Tag not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.label !== undefined) patch.label = label(b.label);
  if (b.isActive !== undefined) patch.is_active = !!b.isActive;
  if (b.groupKey !== undefined) {
    const gk = String(b.groupKey);
    if (!KEY_RE.test(gk)) throw badRequest("Pick a group.");
    patch.group_key = gk;
  }
  if (b.sortOrder !== undefined) {
    const n = Number(b.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw badRequest("Bad order.");
    patch.sort_order = n;
  }
  const { data, error } = await db().from("catalog_tags").update(patch).eq("key", key).select("key");
  if (error) throw fail(error.message, "save the tag");
  if (!data?.length) throw notFound("Tag not found.");
  return c.json({ ok: true });
});
