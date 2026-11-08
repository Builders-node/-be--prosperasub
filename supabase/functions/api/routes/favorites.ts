import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, HttpError, notFound } from "../lib/http.ts";

/**
 * Favourites — what a customer liked and kept to come back to.
 *
 *   GET    /account/favorites                 → the list, newest first
 *   POST   /account/favorites        {kind,id} → save (idempotent)
 *   DELETE /account/favorites/:kind/:id        → unsave
 *   POST   /account/favorites/merge  {items}   → a guest's saves, after sign-in
 *
 * A plan is stored by its CANONICAL id (provider_plans.id). A card can hold
 * the legacy id (a cleaning package, a meal plan, a beach plan), so the id is
 * resolved here, once, and the list hands the alias back — the browser then
 * recognises the plan whichever id a screen has in hand.
 */
export const favorites = new Hono();

type Kind = "plan" | "provider" | "vehicle";
const KINDS: readonly Kind[] = ["plan", "provider", "vehicle"];
const ID_RE = /^[0-9a-zA-Z_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Enough for anyone; a ceiling so the table cannot be filled by a script. */
const MAX_PER_USER = 500;

function parse(kind: unknown, id: unknown): { kind: Kind; id: string } {
  const k = String(kind ?? "") as Kind;
  const i = String(id ?? "");
  if (!KINDS.includes(k)) throw badRequest("Unknown kind.");
  if (!ID_RE.test(i)) throw badRequest("Bad id.");
  return { kind: k, id: i };
}

/** The id we store — or null when the thing does not exist. */
async function canonical(kind: Kind, id: string): Promise<string | null> {
  if (kind === "plan") {
    const filter = UUID_RE.test(id) ? `id.eq.${id},source_plan_id.eq.${id}` : `source_plan_id.eq.${id}`;
    const { data } = await db().from("provider_plans").select("id").or(filter).limit(1).maybeSingle();
    return data?.id ? String(data.id) : null;
  }
  if (!UUID_RE.test(id)) return null;
  const table = kind === "provider" ? "providers" : "rental_vehicles";
  const { data } = await db().from(table).select("id").eq("id", id).maybeSingle();
  return data?.id ? String(data.id) : null;
}

async function save(userId: string, kind: Kind, id: string): Promise<string | null> {
  const target = await canonical(kind, id);
  if (!target) return null;
  const { error } = await db().from("favorites")
    .upsert({ user_id: userId, kind, target_id: target }, { onConflict: "user_id,kind,target_id", ignoreDuplicates: true });
  if (error) throw new HttpError(503, "Could not save that just now.");
  return target;
}

async function countFor(userId: string): Promise<number> {
  const { count } = await db().from("favorites").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return count ?? 0;
}

favorites.get("/account/favorites", async (c) => {
  const user = await requireAccount(c);
  const { data, error } = await db().from("favorites")
    .select("kind,target_id,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(MAX_PER_USER);
  if (error) throw new HttpError(503, "Could not load your favourites.");

  // The legacy id each saved plan is also known by.
  const planIds = (data ?? []).filter((r) => r.kind === "plan").map((r) => String(r.target_id));
  const alias = new Map<string, string>();
  if (planIds.length) {
    const { data: plans } = await db().from("provider_plans").select("id,source_plan_id").in("id", planIds);
    for (const p of plans ?? []) if (p.source_plan_id) alias.set(String(p.id), String(p.source_plan_id));
  }

  return c.json({
    items: (data ?? []).map((r) => ({
      kind: r.kind,
      id: String(r.target_id),
      aliases: alias.has(String(r.target_id)) ? [alias.get(String(r.target_id))] : [],
      savedAt: r.created_at,
    })),
  });
});

favorites.post("/account/favorites", async (c) => {
  const user = await requireAccount(c);
  const body = await c.req.json().catch(() => ({}));
  const { kind, id } = parse(body?.kind, body?.id);
  if ((await countFor(user.id)) >= MAX_PER_USER) throw badRequest("Your favourites are full — remove a few first.");
  const target = await save(user.id, kind, id);
  if (!target) throw notFound("That is no longer available.");
  return c.json({ ok: true, kind, id: target }, 201);
});

favorites.delete("/account/favorites/:kind/:id", async (c) => {
  const user = await requireAccount(c);
  const { kind, id } = parse(c.req.param("kind"), c.req.param("id"));
  // Either id a screen holds removes the one row.
  const target = (await canonical(kind, id)) ?? id;
  const { error } = await db().from("favorites").delete()
    .eq("user_id", user.id).eq("kind", kind).eq("target_id", target);
  if (error) throw new HttpError(503, "Could not remove that just now.");
  return c.json({ ok: true });
});

/** A guest's hearts, kept in the browser, moved onto the account at sign-in. */
favorites.post("/account/favorites/merge", async (c) => {
  const user = await requireAccount(c);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body?.items) ? body.items.slice(0, 100) : [];
  let saved = 0;
  const room = MAX_PER_USER - (await countFor(user.id));
  for (const raw of items) {
    if (saved >= room) break;
    try {
      const { kind, id } = parse(raw?.kind, raw?.id);
      if (await save(user.id, kind, id)) saved++;
    } catch {
      // A malformed or vanished item is skipped; the rest still move.
    }
  }
  return c.json({ ok: true, saved });
});
