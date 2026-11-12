import { Hono } from "hono";
import { requireAccount, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, HttpError, notFound } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";

/**
 * Delivery — the platform's zones and the deliveries made into them.
 *
 *   GET    /admin/delivery/zones          every zone, inactive too
 *   POST   /admin/delivery/zones          a zone (see `zoneRow`)
 *   PATCH  /admin/delivery/zones/:id      any of its fields
 *   DELETE /admin/delivery/zones/:id      removed; one that orders point at is
 *                                         switched off instead, so history keeps its zone
 *   GET    /admin/deliveries?status=      orders with a delivery, newest first
 *   PATCH  /admin/deliveries/:id          {status?, courierId?}
 *   GET    /admin/couriers · POST /admin/couriers · PATCH /admin/couriers/:id
 *          {email?} links the courier to an account, which is what lets them in:
 *   GET    /courier/deliveries            the signed-in courier's own deliveries
 *   PATCH  /courier/deliveries/:id        {status: on_the_way | delivered | failed}
 *
 * Shoppers read active zones straight from the table (public RLS); writes
 * come only through here. The order's own delivery (zone, point, fee) is
 * checked and priced by the database (stamp_order_delivery), not by this file.
 */
export const delivery = new Hono();

const PERMISSION = "admin_settings.read";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "assigned", "on_the_way", "delivered", "failed"] as const;
const missing = (msg: string) => /delivery_zones|couriers|delivery_status|does not exist/i.test(msg);

const int = (v: unknown, field: string, { min = 0, max = 10_000_000, nullable = true } = {}): number | null => {
  if (v === undefined) return undefined as unknown as null;
  if (v === null || v === "") {
    if (!nullable) throw badRequest(`${field} is required.`);
    return null;
  }
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${field} is out of range.`);
  return n;
};

const lat = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n) || n < -90 || n > 90) throw badRequest("Bad latitude."); return n; };
const lng = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n) || n < -180 || n > 180) throw badRequest("Bad longitude."); return n; };

/** The writable part of a zone, validated. `partial` for a PATCH. */
function zoneRow(b: Record<string, any>, partial: boolean) {
  const row: Record<string, unknown> = {};
  const has = (k: string) => b[k] !== undefined;

  if (!partial || has("name")) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 80) throw badRequest("Give the zone a name (up to 80 characters).");
    row.name = name;
  }
  if (!partial || has("shape") || has("polygon") || has("center") || has("radiusM")) {
    const shape = String(b.shape ?? "");
    if (shape === "polygon") {
      const pts = Array.isArray(b.polygon) ? b.polygon : [];
      if (pts.length < 3 || pts.length > 500) throw badRequest("Draw at least three points.");
      row.shape = "polygon";
      row.polygon = pts.map((p: unknown) => {
        const [x, y] = Array.isArray(p) ? p : [];
        return [lng(x), lat(y)];
      });
      row.center_lat = null; row.center_lng = null; row.radius_m = null;
    } else if (shape === "circle") {
      row.shape = "circle";
      row.center_lat = lat(b.center?.lat);
      row.center_lng = lng(b.center?.lng);
      row.radius_m = int(b.radiusM, "Radius", { min: 100, max: 100_000, nullable: false });
      row.polygon = null;
    } else {
      throw badRequest("A zone is a drawn area or a circle.");
    }
  }
  if (!partial || has("feeCents")) row.fee_cents = int(b.feeCents ?? 0, "Fee", { nullable: false });
  if (has("freeFromCents")) row.free_from_cents = int(b.freeFromCents, "Free from");
  if (has("minOrderCents")) row.min_order_cents = int(b.minOrderCents, "Minimum order");
  if (has("etaMinMinutes")) row.eta_min_minutes = int(b.etaMinMinutes, "Delivery time", { max: 60 * 24 * 30 });
  if (has("etaMaxMinutes")) row.eta_max_minutes = int(b.etaMaxMinutes, "Delivery time", { max: 60 * 24 * 30 });
  if (has("color")) {
    const c = b.color === null ? null : String(b.color);
    if (c !== null && !/^#[0-9a-fA-F]{6}$/.test(c)) throw badRequest("Bad colour.");
    row.color = c;
  }
  if (has("isActive")) row.is_active = !!b.isActive;
  if (has("sortOrder")) row.sort_order = int(b.sortOrder, "Order", { nullable: false, max: 100_000 });
  if (row.eta_min_minutes != null && row.eta_max_minutes != null && Number(row.eta_max_minutes) < Number(row.eta_min_minutes)) {
    throw badRequest("The longest time can't be shorter than the shortest.");
  }
  return row;
}

const fail = (e: { message: string } | null) => {
  if (!e) return;
  if (missing(e.message)) throw new HttpError(503, "delivery_not_enabled");
  throw new HttpError(400, e.message);
};

// ── Zones ────────────────────────────────────────────────────────────────────

delivery.get("/admin/delivery/zones", async (c) => {
  await requireAdmin(c, PERMISSION);
  const { data, error } = await db().from("delivery_zones").select("*")
    .is("provider_id", null).order("sort_order").order("created_at");
  if (error && missing(error.message)) return c.json({ enabled: false, zones: [] });
  fail(error);
  return c.json({ enabled: true, zones: data ?? [] });
});

delivery.post("/admin/delivery/zones", async (c) => {
  await requireAdmin(c, PERMISSION);
  const b = await c.req.json().catch(() => ({})) as Record<string, any>;
  const row = zoneRow(b, false);
  const { data, error } = await db().from("delivery_zones").insert({ ...row, provider_id: null }).select().single();
  fail(error);
  return c.json(data, 201);
});

delivery.patch("/admin/delivery/zones/:id", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("zone_not_found");
  const b = await c.req.json().catch(() => ({})) as Record<string, any>;
  const row = zoneRow(b, true);
  if (!Object.keys(row).length) throw badRequest("Nothing to change.");
  const { data, error } = await db().from("delivery_zones")
    .update({ ...row, updated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle();
  fail(error);
  if (!data) throw notFound("zone_not_found");
  return c.json(data);
});

delivery.delete("/admin/delivery/zones/:id", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("zone_not_found");
  const { count } = await db().from("provider_subscriptions")
    .select("id", { count: "exact", head: true }).eq("delivery_zone_id", id);
  if ((count ?? 0) > 0) {
    // Orders point at it: keep the row so they still say where they went.
    const { error } = await db().from("delivery_zones").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
    fail(error);
    return c.json({ ok: true, archived: true });
  }
  const { error } = await db().from("delivery_zones").delete().eq("id", id);
  fail(error);
  return c.json({ ok: true, archived: false });
});

// ── Deliveries ───────────────────────────────────────────────────────────────

delivery.get("/admin/deliveries", async (c) => {
  await requireAdmin(c, PERMISSION);
  const status = c.req.query("status");
  let q = db().from("provider_subscriptions")
    .select("id,provider_id,plan_id,user_id,start_date,status,payment_status,price_cents,delivery_fee_cents,delivery_point,delivery_zone_id,delivery_status,delivered_by,courier_id,delivered_at,customer_whatsapp,notes,metadata,created_at,providers(name),delivery_zones(name)")
    .not("delivery_zone_id", "is", null)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(300);
  if (status && (STATUSES as readonly string[]).includes(status)) q = q.eq("delivery_status", status);
  const { data, error } = await q;
  if (error && missing(error.message)) return c.json({ enabled: false, rows: [] });
  fail(error);
  return c.json({ enabled: true, rows: data ?? [] });
});

delivery.patch("/admin/deliveries/:id", async (c) => {
  const admin = await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("delivery_not_found");
  const b = await c.req.json().catch(() => ({})) as { status?: string; courierId?: string | null };
  const patch: Record<string, unknown> = {};
  if (b.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(String(b.status))) throw badRequest("Unknown status.");
    patch.delivery_status = b.status;
    patch.delivered_at = b.status === "delivered" ? new Date().toISOString() : null;
  }
  if (b.courierId !== undefined) {
    if (b.courierId !== null && !UUID_RE.test(String(b.courierId))) throw badRequest("Unknown courier.");
    patch.courier_id = b.courierId;
    if (b.courierId && b.status === undefined) patch.delivery_status = "assigned";
  }
  if (!Object.keys(patch).length) throw badRequest("Nothing to change.");
  const { data: row, error } = await db().from("provider_subscriptions")
    .update(patch).eq("id", id).not("delivery_zone_id", "is", null)
    .select("id,user_id,delivery_status,metadata").maybeSingle();
  fail(error);
  if (!row) throw notFound("delivery_not_found");

  await tellCustomer(row, String(patch.delivery_status ?? ""));
  await db().from("admin_audit_logs").insert({
    admin_user_id: admin.id, action: "delivery_update", entity_type: "provider_subscription", entity_id: id, details: patch,
  }).then(() => undefined, () => undefined);
  return c.json({ ok: true, row });
});

/** The customer hears when it leaves and when it arrives — nothing in between. */
async function tellCustomer(row: { id: string; user_id: unknown; metadata: unknown }, status: string) {
  const said: Record<string, [string, string]> = {
    on_the_way: ["Your order is on the way", "The courier has it and is heading to you."],
    delivered: ["Delivered", "Your order has been delivered. Enjoy!"],
  };
  const msg = said[status];
  if (!msg || !row.user_id) return;
  const plan = (row.metadata as { plan_name?: string } | null)?.plan_name;
  await notifyUser({
    recipientUserId: String(row.user_id), category: "orders", type: `delivery_${status}`,
    title: msg[0], body: plan ? `${plan} — ${msg[1]}` : msg[1],
    relatedEntityType: "provider_subscriptions", relatedEntityId: row.id, actionUrl: "/my-subscriptions",
  }).catch(() => undefined);
}

// ── Couriers ─────────────────────────────────────────────────────────────────

/** An account id from an email, or a 400 that says so. */
async function accountByEmail(raw: unknown): Promise<string> {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("That doesn't look like an email.");
  const { data } = await db().from("users").select("id").ilike("email", email).limit(1).maybeSingle();
  if (!data?.id) throw badRequest("No EverySub account with that email — ask them to sign up first.");
  return String(data.id);
}

delivery.get("/admin/couriers", async (c) => {
  await requireAdmin(c, PERMISSION);
  const { data, error } = await db().from("couriers").select("*").order("name");
  if (error && missing(error.message)) return c.json({ enabled: false, couriers: [] });
  fail(error);
  return c.json({ enabled: true, couriers: data ?? [] });
});

delivery.post("/admin/couriers", async (c) => {
  await requireAdmin(c, PERMISSION);
  const b = await c.req.json().catch(() => ({})) as { name?: string; phone?: string; email?: string };
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 80) throw badRequest("Give the courier a name.");
  const phone = String(b.phone ?? "").trim().slice(0, 40) || null;
  const user_id = b.email ? await accountByEmail(b.email) : null;
  const { data, error } = await db().from("couriers").insert({ name, phone, user_id }).select().single();
  fail(error);
  return c.json(data, 201);
});

delivery.patch("/admin/couriers/:id", async (c) => {
  await requireAdmin(c, PERMISSION);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("courier_not_found");
  const b = await c.req.json().catch(() => ({})) as { name?: string; phone?: string; isActive?: boolean; email?: string | null };
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name || name.length > 80) throw badRequest("Give the courier a name.");
    patch.name = name;
  }
  if (b.phone !== undefined) patch.phone = String(b.phone ?? "").trim().slice(0, 40) || null;
  if (b.isActive !== undefined) patch.is_active = !!b.isActive;
  if (b.email !== undefined) patch.user_id = b.email ? await accountByEmail(b.email) : null;
  if (!Object.keys(patch).length) throw badRequest("Nothing to change.");
  const { data, error } = await db().from("couriers").update(patch).eq("id", id).select().maybeSingle();
  fail(error);
  if (!data) throw notFound("courier_not_found");
  return c.json(data);
});

// ── The courier's own screen ─────────────────────────────────────────────────

/** The signed-in person's active courier row, or a 403. */
async function myCourier(c: Parameters<typeof requireAccount>[0]) {
  const user = await requireAccount(c);
  const { data, error } = await db().from("couriers").select("id,name").eq("user_id", user.id).eq("is_active", true).limit(1).maybeSingle();
  if (error && missing(error.message)) throw new HttpError(503, "delivery_not_enabled");
  if (!data) throw new HttpError(403, "not_a_courier");
  return data as { id: string; name: string };
}

const COURIER_SELECT = "id,start_date,delivery_status,delivery_point,delivered_at,delivery_fee_cents,customer_whatsapp,notes,metadata,created_at,providers(name,location,contact_phone),delivery_zones(name)";

delivery.get("/courier/deliveries", async (c) => {
  const me = await myCourier(c);
  const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
  // What is still to do, plus what was finished in the last day and a half.
  const [open, done] = await Promise.all([
    db().from("provider_subscriptions").select(COURIER_SELECT)
      .eq("courier_id", me.id).in("delivery_status", ["assigned", "on_the_way", "pending"])
      .order("created_at", { ascending: true }).limit(100),
    db().from("provider_subscriptions").select(COURIER_SELECT)
      .eq("courier_id", me.id).in("delivery_status", ["delivered", "failed"]).gte("delivered_at", since)
      .order("delivered_at", { ascending: false }).limit(50),
  ]);
  fail(open.error); fail(done.error);
  return c.json({ courier: me, open: open.data ?? [], done: done.data ?? [] });
});

delivery.patch("/courier/deliveries/:id", async (c) => {
  const me = await myCourier(c);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("delivery_not_found");
  const b = await c.req.json().catch(() => ({})) as { status?: string };
  const status = String(b.status ?? "");
  if (!["on_the_way", "delivered", "failed"].includes(status)) throw badRequest("Unknown status.");
  const { data: row, error } = await db().from("provider_subscriptions")
    .update({ delivery_status: status, delivered_at: status === "on_the_way" ? null : new Date().toISOString() })
    .eq("id", id).eq("courier_id", me.id)
    .select("id,user_id,delivery_status,metadata").maybeSingle();
  fail(error);
  if (!row) throw notFound("delivery_not_found");
  await tellCustomer(row, status);
  return c.json({ ok: true, row });
});
