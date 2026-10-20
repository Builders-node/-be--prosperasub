import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { notFound } from "../lib/http.ts";

/**
 * Port of AccountLocationsService (backend/src/account). Saved home addresses —
 * physical-safety PII, so the table is service-role only and every query is
 * owner-scoped by the authenticated user id. The default is mirrored into
 * user_profiles.default_delivery_address for the readers that still use it.
 */
export const locations = new Hono();

const WRITABLE = ["label", "residence", "street", "house", "apartment", "area", "notes", "line"] as const;

function clean(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE) if (k in input) out[k] = input[k] ?? null;
  return out;
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

const clearDefaults = (userId: string) =>
  must(db().from("user_locations").update({ is_default: false }).eq("user_id", userId).eq("is_default", true));

async function mirrorDefault(userId: string, line: string | null) {
  const { error } = await db().from("user_profiles").update({ default_delivery_address: line }).eq("user_id", userId);
  if (error) console.warn(`mirrorDefault failed: ${error.message}`);
}

locations.get("/account/locations", async (c) => {
  const user = await requireAccount(c);
  return c.json(await must(db().from("user_locations").select("*").eq("user_id", user.id)
    .order("is_default", { ascending: false }).order("created_at", { ascending: true })));
});

locations.post("/account/locations", async (c) => {
  const user = await requireAccount(c);
  const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = await must(db().from("user_locations").select("id").eq("user_id", user.id).limit(1));
  const makeDefault = input.is_default === true || !existing?.length;
  if (makeDefault) await clearDefaults(user.id);
  const rows = await must(db().from("user_locations").insert({ user_id: user.id, ...clean(input), is_default: makeDefault }).select());
  const row = rows?.[0];
  if (makeDefault && row) await mirrorDefault(user.id, (row.line as string) ?? null);
  return c.json(row ?? null, 201);
});

locations.patch("/account/locations/:id", async (c) => {
  const user = await requireAccount(c);
  const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // The user_id filter is the ownership check — a foreign id patches nothing.
  const rows = await must(db().from("user_locations")
    .update({ ...clean(input), updated_at: new Date().toISOString() })
    .eq("id", c.req.param("id")).eq("user_id", user.id).select());
  const row = rows?.[0];
  if (!row) throw notFound("Location not found.");
  if (row.is_default) await mirrorDefault(user.id, (row.line as string) ?? null);
  return c.json(row);
});

locations.delete("/account/locations/:id", async (c) => {
  const user = await requireAccount(c);
  const rows = await must(db().from("user_locations").delete().eq("id", c.req.param("id")).eq("user_id", user.id).select());
  const removed = rows?.[0];
  if (!removed) throw notFound("Location not found.");
  if (removed.is_default) {
    const next = await must(db().from("user_locations").select("*").eq("user_id", user.id).order("created_at", { ascending: true }).limit(1));
    if (next?.length) {
      await must(db().from("user_locations").update({ is_default: true }).eq("id", next[0].id));
      await mirrorDefault(user.id, (next[0].line as string) ?? null);
    } else {
      await mirrorDefault(user.id, null);
    }
  }
  return c.json({ ok: true });
});

locations.post("/account/locations/:id/default", async (c) => {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  const rows = await must(db().from("user_locations").select("id,line").eq("id", id).eq("user_id", user.id));
  if (!rows?.length) throw notFound("Location not found.");
  await clearDefaults(user.id);
  await must(db().from("user_locations").update({ is_default: true }).eq("id", id).eq("user_id", user.id));
  await mirrorDefault(user.id, (rows[0].line as string) ?? null);
  return c.json({ ok: true }, 201);
});
