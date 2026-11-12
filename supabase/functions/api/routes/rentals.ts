import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccount, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";
import { referenceAlreadyUsed, verifyPayment } from "../lib/paymentCheck.ts";
import { superAdminIds } from "../lib/providerAudience.ts";
import { notifyNewOrder } from "./provider-alerts.ts";

/**
 * Car rentals, server-side — the only way a booking is created, paid,
 * cancelled or edited.
 *
 * Ported from Nest (backend/src/rentals), whose deploys stopped, and closed
 * where the audit found it open:
 *  - the browser no longer writes `rental_*` rows (RLS + revoke, migration
 *    20261113120000); every write is here, behind an account check;
 *  - confirm checks the AMOUNT (the invoice the server recorded) and that the
 *    payment hasn't already settled another order;
 *  - a cancelled booking is not revived silently; a late payment on one is
 *    re-held if the dates are still free, otherwise the admins are told to refund;
 *  - the business is told when a rental is PAID, not when a hold is placed;
 *  - a week never costs more than seven days.
 */
export const rentals = new Hono();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 90;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

const todayHN = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

// ── Pricing (keep in step with frontend features/vehicles/types/carRental.ts) ─

export function rentalDaysBetween(startISO: string, endISO: string): number {
  const s = Date.parse(`${startISO}T00:00:00Z`);
  const e = Date.parse(`${endISO}T00:00:00Z`);
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

export function calcRentalPrice(v: { daily_price_cents: number | null; weekly_price_cents: number | null; monthly_price_cents: number | null }, days: number) {
  const daily = Number(v.daily_price_cents) || 0;
  // A weekly price above seven daily ones is a typo, not a policy — every car
  // had one, so a 7-day rental cost more than 6 days plus one.
  const weeklyRaw = Number(v.weekly_price_cents) || 0;
  const weekly = weeklyRaw > 0 ? Math.min(weeklyRaw, daily > 0 ? daily * 7 : weeklyRaw) : 0;
  const monthly = Number(v.monthly_price_cents) || 0;
  const byWeeks = (d: number) => weekly > 0 && d >= 7
    ? Math.floor(d / 7) * weekly + Math.min((d % 7) * daily, weekly)
    : d * daily;
  const subtotal = byWeeks(days);
  // The monthly price caps each 30-day month, not the whole rental — capping
  // the total let 60 or 90 days cost one month's price.
  const byMonths = monthly > 0
    ? Math.floor(days / 30) * monthly + Math.min(byWeeks(days % 30), monthly)
    : subtotal;
  const total = Math.min(subtotal, byMonths);
  const discount = Math.max(0, subtotal - total);
  return {
    rentalDays: days, subtotalCents: subtotal, totalCents: total, discountCents: discount,
    discountPct: subtotal > 0 ? Math.round((discount / subtotal) * 100) : 0,
    effectiveDailyRate: days > 0 ? Math.round(total / days) : daily,
  };
}

const extraCost = (e: { price_cents: number; price_type: string }, days: number) =>
  e.price_type === "per_day" ? Number(e.price_cents) * Math.max(1, days) : Number(e.price_cents);

async function surchargePct(method: string): Promise<number> {
  const { data } = await db().from("payment_method_settings").select("surcharge_percent").eq("method", method).maybeSingle();
  const pct = Number(data?.surcharge_percent ?? 0);
  return Number.isFinite(pct) ? Math.max(0, pct) : 0;
}
const surchargeFor = (base: number, pct: number) => (pct > 0 ? Math.round(base * (1 + pct / 100)) - base : 0);

// ── Create ───────────────────────────────────────────────────────────────────

rentals.post("/rentals/bookings", async (c) => {
  const user = await requireAccount(c);
  if (!UUID.test(user.id)) throw new HttpError(409, "Your account isn't fully set up yet — sign out and in again.");
  const raw = await c.req.json().catch(() => ({})) as Record<string, any>;
  // The page sends snake_case (as it did to Nest); camelCase is accepted too.
  const pick = (camel: string, snake: string) => raw[camel] ?? raw[snake];
  const b = {
    vehicleId: pick("vehicleId", "vehicle_id"), startDate: pick("startDate", "start_date"), endDate: pick("endDate", "end_date"),
    insuranceTierId: pick("insuranceTierId", "insurance_tier_id"), extraIds: pick("extraIds", "extra_ids"),
    deliveryZoneId: pick("deliveryZoneId", "delivery_zone_id"), paymentMethod: pick("paymentMethod", "payment_method"),
    customerName: pick("customerName", "customer_name"), customerWhatsapp: pick("customerWhatsapp", "customer_whatsapp"),
    deliveryAddress: pick("deliveryAddress", "delivery_address"), deliveryNotes: pick("deliveryNotes", "delivery_notes"),
  } as Record<string, any>;
  const startDate = String(b.startDate ?? ""), endDate = String(b.endDate ?? "");
  if (!ISO.test(startDate) || !ISO.test(endDate) || endDate < startDate || startDate < todayHN()) throw badRequest("invalid_dates");
  const days = rentalDaysBetween(startDate, endDate);
  if (days > MAX_DAYS) throw badRequest("invalid_dates");
  const method = String(b.paymentMethod ?? "").toLowerCase();
  if (!["lightning", "onchain", "paypal"].includes(method)) throw badRequest("invalid_payment_method");

  const { data: v } = await db().from("rental_vehicles")
    .select("id,name,provider_id,status,daily_price_cents,weekly_price_cents,monthly_price_cents")
    .eq("id", String(b.vehicleId ?? "")).maybeSingle();
  if (!v || v.status !== "public") throw badRequest("vehicle_unavailable");
  // The hidden-shop rule the DB trigger enforces for browser writes.
  const { data: p } = await db().from("providers").select("status").eq("id", v.provider_id).maybeSingle();
  if (!p || !["active", "approved"].includes(String(p.status))) throw badRequest("vehicle_unavailable");

  // One open hold per person per car: blocking a car with fake holds is not a booking.
  const { data: holds } = await db().from("rental_bookings").select("id")
    .eq("user_id", user.id).eq("vehicle_id", v.id).eq("status", "pending").is("deleted_at", null).limit(1);
  if (holds?.length) {
    await db().from("rental_bookings").update({ status: "cancelled", payment_status: "failed", updated_at: new Date().toISOString() })
      .in("id", holds.map((h) => h.id)).neq("payment_status", "paid");
  }

  const pricing = calcRentalPrice(v, days);
  if (pricing.totalCents <= 0) throw badRequest("vehicle_unavailable");
  const scope = { provider_id: v.provider_id, is_active: true };

  let insurance: any = null;
  if (b.insuranceTierId) {
    ({ data: insurance } = await db().from("rental_insurance_tiers").select("id,name,price_per_day_cents")
      .eq("id", String(b.insuranceTierId)).match(scope).maybeSingle());
    if (!insurance) throw badRequest("invalid_insurance");
  }
  const extraIds = [...new Set(((b.extraIds ?? []) as unknown[]).map(String).filter(Boolean))];
  let extras: any[] = [];
  if (extraIds.length) {
    ({ data: extras } = await db().from("rental_extras").select("id,name,price_cents,price_type").in("id", extraIds).match(scope) as any);
    if ((extras ?? []).length !== extraIds.length) throw badRequest("invalid_extras");
  }
  let zone: any = null;
  if (b.deliveryZoneId) {
    ({ data: zone } = await db().from("rental_delivery_zones").select("id,name,fee_cents")
      .eq("id", String(b.deliveryZoneId)).match(scope).maybeSingle());
    if (!zone) throw badRequest("invalid_zone");
  }

  const insuranceCents = insurance ? Number(insurance.price_per_day_cents || 0) * Math.max(1, days) : 0;
  const extrasPriced = (extras ?? []).map((e) => ({ id: e.id, name: e.name, cents: extraCost(e, days) }));
  const extrasCents = extrasPriced.reduce((s, e) => s + e.cents, 0);
  const deliveryFee = Number(zone?.fee_cents ?? 0);
  const baseTotal = pricing.totalCents + insuranceCents + extrasCents + deliveryFee;
  const surcharge = surchargeFor(baseTotal, await surchargePct(method));

  const insertRow = () => db().from("rental_bookings").insert({
    user_id: user.id, vehicle_id: v.id, start_date: startDate, end_date: endDate, rental_days: days,
    daily_price_cents: pricing.effectiveDailyRate, subtotal_cents: pricing.subtotalCents,
    discount_pct: pricing.discountPct, discount_cents: pricing.discountCents,
    insurance_tier_id: insurance?.id ?? null, insurance_cents: insuranceCents,
    delivery_zone_id: zone?.id ?? null, delivery_fee_cents: deliveryFee,
    extras: extrasPriced, extras_cents: extrasCents, total_cents: baseTotal, surcharge_cents: surcharge,
    customer_name: String(b.customerName ?? "").trim().slice(0, 120) || null,
    customer_whatsapp: String(b.customerWhatsapp ?? "").trim().slice(0, 40) || null,
    delivery_address: String(b.deliveryAddress ?? "").trim().slice(0, 300) || zone?.name || null,
    delivery_notes: String(b.deliveryNotes ?? "").trim().slice(0, 500) || null,
    status: "pending", payment_status: "pending", payment_method: method,
  }).select("id").single();
  let { data: row, error } = await insertRow();
  // The overlap constraint ignores only cancelled rows; an abandoned checkout
  // (unpaid, no reference after 20 min, or a reference after 24 h) still
  // blocks it. Release exactly those and try once more.
  if (error && /23P01|exclusion/i.test(error.message)) {
    const { data: rows } = await db().from("rental_bookings")
      .select("id,payment_reference,created_at")
      .eq("vehicle_id", v.id).neq("status", "cancelled").neq("payment_status", "paid").is("deleted_at", null)
      .lte("start_date", endDate).gte("end_date", startDate);
    const now = Date.now();
    const dead = (rows ?? []).filter((r) => {
      const age = now - Date.parse(String(r.created_at));
      return r.payment_reference ? age > 24 * 3_600_000 : age > 20 * 60_000;
    }).map((r) => r.id);
    if (dead.length) {
      await db().from("rental_bookings").update({ status: "cancelled", payment_status: "failed", updated_at: new Date().toISOString() }).in("id", dead);
      ({ data: row, error } = await insertRow());
    }
  }
  if (error || !row) {
    if (error && /23P01|exclusion/i.test(error.message)) throw new HttpError(409, "dates_taken");
    throw new HttpError(503, "booking_failed");
  }
  return c.json({ id: row.id, total_cents: baseTotal, surcharge_cents: surcharge, charged_cents: baseTotal + surcharge }, 201);
});

// ── The customer's own booking ───────────────────────────────────────────────

async function ownBooking(c: Context) {
  const user = await requireAccount(c);
  const id = c.req.param("id");
  if (!UUID.test(id)) throw notFound("booking_not_found");
  const { data: row } = await db().from("rental_bookings")
    .select("id,user_id,vehicle_id,start_date,end_date,status,payment_status,payment_method,payment_reference,total_cents,surcharge_cents")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (!row) throw notFound("booking_not_found");
  if (String(row.user_id) !== String(user.id) && !isSuperAdmin(user.roles)) throw forbidden("not_your_booking");
  return { user, row };
}

/** The invoice's reference, attached as soon as it exists (so the reconcile cron can find it). */
rentals.post("/rentals/bookings/:id/reference", async (c) => {
  const { row } = await ownBooking(c);
  const b = await c.req.json().catch(() => ({})) as { payment_reference?: unknown; payment_method?: unknown };
  const ref = String(b.payment_reference ?? "").trim();
  const method = String(b.payment_method ?? "").toLowerCase();
  if (!ref || ref.length > 200) throw badRequest("payment_reference_required");
  if (row.payment_status === "paid") return c.json({ ok: true });
  if (row.status === "cancelled") throw new HttpError(409, "booking_cancelled");
  const base = Number(row.total_cents) || 0;
  const surcharge = ["lightning", "onchain", "paypal"].includes(method) ? surchargeFor(base, await surchargePct(method)) : Number(row.surcharge_cents) || 0;
  await db().from("rental_bookings").update({
    payment_reference: ref, payment_method: method || row.payment_method, surcharge_cents: surcharge, updated_at: new Date().toISOString(),
  }).eq("id", row.id).neq("payment_status", "paid");
  return c.json({ ok: true, charged_cents: base + surcharge });
});

rentals.post("/rentals/bookings/:id/confirm", async (c) => {
  const { row } = await ownBooking(c);
  if (row.payment_status === "paid") return c.json({ confirmed: true, id: row.id });
  const b = await c.req.json().catch(() => ({})) as { payment_reference?: unknown; payment_method?: unknown };
  const ref = String(b.payment_reference ?? "").trim();
  const method = String(b.payment_method ?? "").toLowerCase();
  if (!ref) throw badRequest("payment_reference_required");

  if (await referenceAlreadyUsed(ref, { table: "rental_bookings", id: row.id })) throw forbidden("payment_already_used");
  const base = Number(row.total_cents) || 0;
  const surcharge = surchargeFor(base, await surchargePct(method));
  const check = await verifyPayment(method, ref, base + surcharge);
  if (!check.ok) throw forbidden(check.reason);

  const paidPatch = {
    payment_status: "paid", payment_method: method, payment_reference: ref, surcharge_cents: surcharge,
    updated_at: new Date().toISOString(),
  };

  // Paid after the hold lapsed: take the dates back if nobody else has them,
  // otherwise keep the money on record and get a person to refund it.
  if (row.status === "cancelled") {
    const { error } = await db().from("rental_bookings").update({ ...paidPatch, status: "confirmed" }).eq("id", row.id);
    if (error) {
      await db().from("rental_bookings").update(paidPatch).eq("id", row.id);
      const admins = await superAdminIds();
      await Promise.all(admins.map((id) => notifyUser({
        recipientUserId: id, category: "business", type: "refund_requested",
        title: "Rental paid after its dates were taken — refund needed",
        body: `Booking ${row.id} (${row.start_date} → ${row.end_date}) was paid after its hold expired, and the car is booked by someone else.`,
        relatedEntityType: "rental_bookings", relatedEntityId: row.id, actionUrl: "/admin/vehicles",
      })));
      return c.json({ confirmed: false, refundNeeded: true, id: row.id }, 409);
    }
  } else {
    const { error } = await db().from("rental_bookings").update({ ...paidPatch, status: "confirmed" }).eq("id", row.id);
    if (error) throw new HttpError(503, "confirm_failed");
  }
  // The business hears about a rental when it is PAID — not about every hold.
  await notifyNewOrder("rental_bookings", row.id).catch(() => undefined);
  return c.json({ confirmed: true, id: row.id });
});

rentals.post("/rentals/bookings/:id/cancel", async (c) => {
  const { row } = await ownBooking(c);
  if (row.payment_status === "paid") throw new HttpError(409, "paid_bookings_are_cancelled_by_support");
  if (row.status === "cancelled") return c.json({ ok: true });
  await db().from("rental_bookings").update({ status: "cancelled", payment_status: "failed", updated_at: new Date().toISOString() })
    .eq("id", row.id).neq("payment_status", "paid");
  return c.json({ ok: true });
});

// ── Admin ────────────────────────────────────────────────────────────────────

const ADMIN_FIELDS = new Set(["status", "start_date", "end_date", "customer_name", "customer_whatsapp", "delivery_address", "delivery_notes", "total_cents"]);

/**
 * An admin edit. The lifecycle and the money are separate on purpose: changing
 * the status never says a payment happened, and "mark paid" needs a reason.
 * Cancelling a PAID booking keeps the payment on record and flags a refund.
 */
rentals.patch("/admin/rentals/bookings/:id", async (c) => {
  const admin = await requireAdmin(c, "subscriptions.read");
  const id = c.req.param("id");
  if (!UUID.test(id)) throw notFound("booking_not_found");
  const b = await c.req.json().catch(() => ({})) as Record<string, any>;
  const { data: row } = await db().from("rental_bookings").select("id,status,payment_status").eq("id", id).maybeSingle();
  if (!row) throw notFound("booking_not_found");

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.fields ?? {})) if (ADMIN_FIELDS.has(k)) patch[k] = v;
  if (b.markPaid) {
    const note = String(b.markPaid.note ?? "").trim();
    if (note.length < 3) throw badRequest("Say why it is paid (cash, bank transfer…).");
    patch.payment_status = "paid";
    patch.payment_method = String(b.markPaid.method ?? "manual").slice(0, 40);
    if (b.markPaid.reference) patch.payment_reference = String(b.markPaid.reference).slice(0, 200);
    if (!patch.status && row.status === "pending") patch.status = "confirmed";
  }
  if (patch.status === "cancelled" && row.payment_status !== "paid") patch.payment_status = "failed";
  if (!Object.keys(patch).length) throw badRequest("Nothing to change.");
  patch.updated_at = new Date().toISOString();
  const { error } = await db().from("rental_bookings").update(patch).eq("id", id);
  if (error) throw new HttpError(/23P01|exclusion/i.test(error.message) ? 409 : 503, /23P01|exclusion/i.test(error.message) ? "dates_taken" : "update_failed");
  await db().from("admin_audit_logs").insert({
    admin_user_id: admin.id, action: b.markPaid ? "mark_paid" : "edit", entity_type: "rental_booking", entity_id: id,
    details: { ...patch, note: b.markPaid?.note ?? null },
  }).then(() => undefined, () => undefined);
  const refundNeeded = patch.status === "cancelled" && row.payment_status === "paid";
  if (b.markPaid) await notifyNewOrder("rental_bookings", id).catch(() => undefined);
  return c.json({ ok: true, refundNeeded });
});

rentals.delete("/admin/rentals/bookings/:id", async (c) => {
  await requireAdmin(c, "subscriptions.read");
  const id = c.req.param("id");
  if (!UUID.test(id)) throw notFound("booking_not_found");
  const { data: row } = await db().from("rental_bookings").select("payment_status").eq("id", id).maybeSingle();
  if (!row) throw notFound("booking_not_found");
  if (row.payment_status === "paid") throw new HttpError(409, "A paid booking is history — cancel or refund it.");
  await db().from("rental_bookings").update({ deleted_at: new Date().toISOString(), status: "cancelled" }).eq("id", id);
  return c.json({ ok: true });
});

// ── Fleet and terms: the business (or an admin) edits its own rows ───────────

const FLEET_TABLES: Record<string, { key: "id" | "key"; providerScoped: boolean }> = {
  rental_vehicles: { key: "id", providerScoped: true },
  rental_insurance_tiers: { key: "id", providerScoped: true },
  rental_extras: { key: "id", providerScoped: true },
  rental_delivery_zones: { key: "id", providerScoped: true },
  rental_categories: { key: "key", providerScoped: false },
};

async function runsProvider(userId: string, roles: string[], providerId: string | null): Promise<boolean> {
  if (isSuperAdmin(roles)) return true;
  if (!providerId || !UUID.test(providerId)) return false;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (p?.admin_user_id && String(p.admin_user_id) === String(userId)) return true;
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  return !!m?.length;
}

/** { table, op: insert|update|delete, id?, row? } — checked against the business that owns the row. */
rentals.post("/account/rental-fleet", async (c) => {
  const user = await requireAccount(c);
  const b = await c.req.json().catch(() => ({})) as { table?: string; op?: string; id?: string; row?: Record<string, unknown> };
  const spec = b.table ? FLEET_TABLES[b.table] : undefined;
  if (!spec) throw badRequest("Unknown table.");
  const op = b.op;
  if (op !== "insert" && op !== "update" && op !== "delete") throw badRequest("Unknown operation.");
  // Vehicle types are the platform's vocabulary — admins only.
  if (!spec.providerScoped && !isSuperAdmin(user.roles)) throw forbidden("Only EverySub edits vehicle types.");

  const row = { ...(b.row ?? {}) };
  delete (row as any).created_at;
  let providerId: string | null = null;
  if (op !== "insert") {
    if (!b.id) throw badRequest("id required");
    if (spec.providerScoped) {
      const { data: existing } = await db().from(b.table!).select("provider_id").eq(spec.key, b.id).maybeSingle();
      if (!existing) throw notFound("Not found.");
      providerId = existing.provider_id ? String(existing.provider_id) : null;
      // Moving a row to another business is not an edit.
      if ("provider_id" in row && String(row.provider_id) !== providerId) throw forbidden("A row can't change business.");
    }
  } else if (spec.providerScoped) {
    providerId = row.provider_id ? String(row.provider_id) : null;
  }
  if (spec.providerScoped && !(await runsProvider(user.id, user.roles, providerId))) throw forbidden("You don't run this business.");

  const q = op === "insert"
    ? db().from(b.table!).insert(row).select().single()
    : op === "update"
      ? db().from(b.table!).update({ ...row, ...(b.table === "rental_categories" ? {} : { updated_at: new Date().toISOString() }) }).eq(spec.key, b.id!).select().single()
      : db().from(b.table!).delete().eq(spec.key, b.id!);
  const { data, error } = await q;
  if (error) throw new HttpError(400, error.message);
  return c.json(data ?? { ok: true });
});
