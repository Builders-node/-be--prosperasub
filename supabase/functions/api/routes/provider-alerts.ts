import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccount, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  appUrl, providerAudience, superAdminIds, tellProvider, universalProviderId, usd,
} from "../lib/providerAudience.ts";
import { isAllowedOrigin } from "../lib/cors.ts";
import { createOwnerInvite } from "./owner-invites.ts";

/**
 * Everything a business is TOLD — the owner's side of the platform.
 *
 * Before this the owner heard about a new order only by an email sent from the
 * NestJS API (whose deploys stopped), about a cancellation not at all, and
 * about going live, an application decision or tomorrow's visits never. Each
 * route here writes an in-app notification for every account on the business
 * and an email to each address (lib/providerAudience.ts).
 */
export const providerAlerts = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

// ── 1. New order (port of Nest ProviderOrderMailService) ─────────────────────

/** How to read an order from each table. Money and dates come from the row, never the caller. */
const ORDER_SOURCES: Record<string, {
  select: string;
  title: (r: any) => string;
  totalCents: (r: any) => number;
  starts: (r: any) => string | null;
  customer: (r: any) => string | null;
}> = {
  provider_subscriptions: {
    select: "id,provider_id,user_id,price_cents,start_date,end_date,metadata,payment_method,payment_status",
    title: (r) => r.metadata?.plan_name || "Subscription",
    totalCents: (r) => Number(r.price_cents) || 0,
    starts: (r) => r.start_date ?? null,
    customer: (r) => r.metadata?.customer_name || null,
  },
  food_subscriptions: {
    select: "id,provider_id,customer_name,weekly_price_cents,commitment_weeks,started_at,end_date,payment_method,payment_status",
    title: () => "Meal plan",
    totalCents: (r) => (Number(r.weekly_price_cents) || 0) * Math.max(Number(r.commitment_weeks) || 1, 1),
    starts: (r) => r.started_at ?? null,
    customer: (r) => r.customer_name ?? null,
  },
  cleaning_subscriptions: {
    select: "id,provider_id,user_id,total_price_cents,monthly_price_cents,service_start_date,service_end_date,payment_method,payment_status",
    title: () => "Cleaning plan",
    totalCents: (r) => Number(r.total_price_cents) || Number(r.monthly_price_cents) || 0,
    starts: (r) => r.service_start_date ?? null,
    customer: () => null,
  },
  rental_bookings: {
    select: "id,provider_id,user_id,customer_name,total_cents,start_date,end_date,payment_method,payment_status",
    title: () => "Vehicle booking",
    totalCents: (r) => Number(r.total_cents) || 0,
    starts: (r) => r.start_date ?? null,
    customer: (r) => r.customer_name ?? null,
  },
};

/** Idempotent: the first caller to claim the ledger row tells the business; later callers are no-ops. */
export async function notifyNewOrder(table: string, orderId: string): Promise<{ sent: boolean; reason?: string }> {
  const source = ORDER_SOURCES[table];
  if (!source) return { sent: false, reason: "unknown-table" };
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(orderId)) return { sent: false, reason: "no-order" };
  const { data: order } = await db().from(table).select(source.select).eq("id", orderId).maybeSingle();
  if (!order) return { sent: false, reason: "no-order" };
  const providerId = await universalProviderId(table, (order as any).provider_id);
  if (!providerId) return { sent: false, reason: "no-provider" };
  const audience = await providerAudience(providerId);
  if (!audience || (!audience.emails.length && !audience.userIds.length)) return { sent: false, reason: "no-recipients" };

  // Claim first — a checkout tab and the payment webhook may both call this.
  const { data: claimed, error } = await db().from("provider_order_notifications")
    .upsert({ order_table: table, order_id: orderId, kind: "new_order", provider_id: providerId, recipients: audience.emails },
      { onConflict: "order_table,order_id,kind", ignoreDuplicates: true })
    .select("order_id");
  if (error) { console.warn(`[new-order] claim failed ${table}:${orderId}: ${error.message}`); return { sent: false, reason: "claim-failed" }; }
  if (!claimed?.length) return { sent: false, reason: "already-sent" };

  const o = order as any;
  const title = source.title(o);
  await tellProvider(audience, {
    type: "provider_new_order",
    title: "New order",
    body: `${title}${source.customer(o) ? ` for ${source.customer(o)}` : ""} — ${usd(source.totalCents(o))}.`,
    facts: [
      ["What", title],
      ["Customer", source.customer(o)],
      ["Total", usd(source.totalCents(o))],
      ["Starts", source.starts(o)],
      ["Payment", `${o.payment_status ?? "pending"}${o.payment_method ? ` · ${o.payment_method}` : ""}`],
    ],
    actionPath: `/my-provider/${providerId}?tab=bookings`,
    relatedEntityType: table,
    relatedEntityId: orderId,
  });
  return { sent: true };
}

providerAlerts.post("/mail/new-order", async (c) => {
  await requireAccount(c);
  const body = await c.req.json().catch(() => ({})) as { table?: string; orderId?: string };
  if (!body.table || !body.orderId) throw badRequest("table and orderId are required");
  return c.json(await notifyNewOrder(String(body.table), String(body.orderId)), 201);
});

// ── 2. The owner says "ready" ────────────────────────────────────────────────

async function assertRunsProvider(userId: string, providerId: string, roles: string[]) {
  if (isSuperAdmin(roles)) return;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (p.admin_user_id && String(p.admin_user_id) === String(userId)) return;
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  if (!m?.length) throw forbidden("You don't run this business.");
}

providerAlerts.post("/account/providers/:id/review-request", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  await assertRunsProvider(user.id, providerId, user.roles);
  const { data: p } = await db().from("providers").select("id,name,status").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (p.status === "active" || p.status === "approved") return c.json({ ok: true, alreadyLive: true });

  // Stamp it (column from 20261110120000; tolerated before then).
  await db().from("providers").update({ review_requested_at: new Date().toISOString() }).eq("id", providerId)
    .then(() => undefined, () => undefined);

  const admins = await superAdminIds();
  await Promise.all(admins.map((id) => notifyUser({
    recipientUserId: id,
    category: "business",
    type: "provider_review_requested",
    title: `${p.name} is ready for review`,
    body: "The owner says the business is set up. Check it and put it live.",
    relatedEntityType: "provider",
    relatedEntityId: providerId,
    actionUrl: `/admin/marketplace/providers/${providerId}`,
  })));
  const inbox = Deno.env.get("SUPPORT_INBOX_EMAIL")?.trim() || Deno.env.get("MAIL_REPLY_TO")?.trim();
  if (inbox) {
    const url = `${appUrl()}/admin/marketplace/providers/${providerId}`;
    await sendMail({
      to: inbox,
      subject: `Ready for review · ${p.name}`,
      text: `${p.name} asks to go live.\n${url}`,
      html: `<p><strong>${escapeHtml(String(p.name))}</strong> asks to go live.</p><p><a href="${escapeHtml(url)}">Review it</a></p>`,
    }).catch((e) => console.warn(`[review-request] mail failed: ${(e as Error).message}`));
  }
  return c.json({ ok: true });
});

// ── 3. It went live ──────────────────────────────────────────────────────────

providerAlerts.post("/admin/providers/:id/went-live", async (c) => {
  await requireAdmin(c);
  const providerId = c.req.param("id");
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  const audience = await providerAudience(providerId);
  if (!audience) throw notFound("Business not found.");
  await tellProvider(audience, {
    type: "provider_live",
    title: "You're live",
    body: `${audience.name} is now on EverySub — customers can find it and buy its plans. Share your page and your QR code: customers who come through your code pay you 0% commission.`,
    actionPath: `/my-provider/${providerId}`,
  });
  return c.json({ ok: true });
});

// ── 4. An application was decided ────────────────────────────────────────────

providerAlerts.post("/admin/provider-applications/:id/decision", async (c) => {
  const admin = await requireAdmin(c);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Application not found.");
  const { data: app } = await db().from("provider_applications")
    .select("id,user_id,business_name,contact_email,status,review_notes,created_provider_id").eq("id", id).maybeSingle();
  if (!app) throw notFound("Application not found.");
  if (app.status !== "approved" && app.status !== "rejected") throw badRequest("The application has no decision yet.");

  const name = String(app.business_name ?? "your business");
  const origin = isAllowedOrigin(c.req.header("origin")) ? c.req.header("origin")! : appUrl();
  let link: string | null = null;
  let ownerSet = false;

  if (app.status === "approved" && app.created_provider_id) {
    const { data: p } = await db().from("providers").select("admin_user_id").eq("id", app.created_provider_id).maybeSingle();
    ownerSet = !!p?.admin_user_id;
    // No account to attach yet → the decision email carries the hand-over link.
    if (!ownerSet && app.contact_email) {
      const inv = await createOwnerInvite({ providerId: String(app.created_provider_id), createdBy: admin.id, origin, email: null });
      link = inv.url;
    }
  }

  const approved = app.status === "approved";
  const title = approved ? `${name} is approved` : `About your application for ${name}`;
  const body = approved
    ? ownerSet
      ? `Welcome to EverySub! ${name} is set up as a draft in your account — add photos and plans, then press "Ready for review".`
      : `Welcome to EverySub! Open the link below, sign in with this email and accept — ${name} becomes yours to set up.`
    : `We couldn't approve ${name} this time.${app.review_notes ? ` Reason: ${app.review_notes}` : ""} Reply to this email if you'd like to talk about it.`;
  const action = approved && app.created_provider_id && ownerSet ? `/my-provider/${app.created_provider_id}` : "/become-a-provider";

  if (app.user_id && UUID_RE.test(String(app.user_id))) {
    await notifyUser({
      recipientUserId: String(app.user_id), category: "business",
      type: approved ? "application_approved" : "application_rejected",
      title, body, relatedEntityType: "provider_application", relatedEntityId: id, actionUrl: action,
    });
  }
  let emailed = false;
  if (app.contact_email) {
    const url = link ?? `${appUrl()}${action}`;
    try {
      const r = await sendMail({
        to: String(app.contact_email),
        subject: title,
        text: `${body}\n\n${url}`,
        html: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(url)}">${approved ? (link ? `Take over ${escapeHtml(name)}` : "Open your business") : "EverySub"}</a></p>`,
      });
      emailed = !!r.sent;
    } catch (e) {
      console.warn(`[application-decision] mail failed: ${(e as Error).message}`);
    }
  }
  return c.json({ ok: true, emailed, inviteLink: link });
});

// ── 5. Tomorrow, every morning ───────────────────────────────────────────────

/** pg_cron calls this with a key kept in Vault; checked by a service-role-only function. */
async function requireCronKey(c: Context) {
  const key = c.req.header("x-cron-key");
  if (!key) throw unauthorized("Cron key required");
  const { data, error } = await db().rpc("cron_key_matches", { p_name: "provider_digest_key", p_key: key });
  if (error || data !== true) throw unauthorized("Bad cron key");
}

/** Honduras is UTC−6 all year. */
const HN_OFFSET_MS = 6 * 3_600_000;

providerAlerts.post("/cron/provider-digest", async (c) => {
  await requireCronKey(c);
  const nowHn = new Date(Date.now() - HN_OFFSET_MS);
  const day = new Date(Date.UTC(nowHn.getUTCFullYear(), nowHn.getUTCMonth(), nowHn.getUTCDate() + 1));
  const from = new Date(day.getTime() + HN_OFFSET_MS).toISOString();
  const to = new Date(day.getTime() + HN_OFFSET_MS + 86_400_000).toISOString();
  const label = day.toISOString().slice(0, 10);

  const { data: occ, error } = await db().from("service_occurrences")
    .select("id,provider_id,user_id,item_key,starts_at,status,notes")
    .gte("starts_at", from).lt("starts_at", to)
    .not("status", "in", "(cancelled,skipped,failed)")
    .order("starts_at");
  if (error) throw new HttpError(503, `Could not read tomorrow: ${error.message}`);

  const byProvider = new Map<string, any[]>();
  for (const o of occ ?? []) {
    if (!o.provider_id) continue;
    const list = byProvider.get(String(o.provider_id)) ?? [];
    list.push(o);
    byProvider.set(String(o.provider_id), list);
  }
  const userIds = [...new Set((occ ?? []).map((o) => o.user_id).filter((u) => u && UUID_RE.test(String(u))))];
  const { data: users } = userIds.length
    ? await db().from("users").select("id,display_name,name").in("id", userIds)
    : { data: [] as any[] };
  const nameOf = new Map((users ?? []).map((u: any) => [String(u.id), u.display_name || u.name || "Customer"]));
  const time = (iso: string) => new Date(Date.parse(iso) - HN_OFFSET_MS).toISOString().slice(11, 16);

  let sent = 0;
  for (const [providerId, list] of byProvider) {
    const audience = await providerAudience(providerId);
    if (!audience?.emails.length) continue;
    // A busy kitchen has dozens of deliveries a day; the email lists the first
    // 40 and the schedule has the rest.
    const shown = list.slice(0, 40);
    const more = list.length - shown.length;
    const rows = shown.map((o) => [
      time(o.starts_at),
      String(o.item_key ?? "Visit").replace(/_/g, " "),
      o.user_id ? nameOf.get(String(o.user_id)) ?? "Customer" : "Customer",
    ]);
    const url = `${appUrl()}/my-provider/${providerId}?tab=bookings`;
    const text = [`Tomorrow (${label}) ${audience.name} has ${list.length} on the schedule:`, "",
      ...rows.map((r) => `${r[0]}  ${r[1]} — ${r[2]}`), ...(more > 0 ? [`…and ${more} more`] : []), "", `Full schedule: ${url}`].join("\n");
    const html = `<h2>Tomorrow: ${list.length} on the schedule</h2>
      <p>${escapeHtml(audience.name)} · ${label}</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">${rows.map((r) =>
        `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${escapeHtml(r[1])}</td><td>${escapeHtml(r[2])}</td></tr>`).join("")}</table>
      ${more > 0 ? `<p>…and ${more} more.</p>` : ""}
      <p><a href="${escapeHtml(url)}">Open the schedule</a></p>`;
    for (const to of audience.emails) {
      try { await sendMail({ to, subject: `Tomorrow: ${list.length} on the schedule · ${audience.name}`, text, html }); sent++; }
      catch (e) { console.warn(`[digest] ${to}: ${(e as Error).message}`); }
    }
  }
  return c.json({ ok: true, day: label, businesses: byProvider.size, emails: sent });
});
