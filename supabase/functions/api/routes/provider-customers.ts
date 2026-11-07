import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { notifyUser } from "../lib/notify.ts";
import { appUrl, providerAudience, superAdminIds, universalProviderId } from "../lib/providerAudience.ts";

/**
 * A business and its customers — the owner's side, through the API.
 *
 *  - cancel a subscriber: the customer is told and, if asked, a refund
 *    request reaches EverySub (it used to be a silent browser write);
 *  - message every active subscriber (once a day, logged);
 *  - see who came through the business's own code (0% commission);
 *  - answer a review in public.
 *
 * Every route checks the caller is the owner, a team member, or an admin.
 */
export const providerCustomers = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

async function assertRuns(userId: string, providerId: string, roles: string[]) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (isSuperAdmin(roles)) return;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (p.admin_user_id && String(p.admin_user_id) === String(userId)) return;
  const { data: m } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", userId).limit(1);
  if (!m?.length) throw forbidden("You don't run this business.");
}

// ── Cancel a subscriber ──────────────────────────────────────────────────────

const TABLES: Record<string, { statusCol: string; label: string; extra?: Record<string, unknown> }> = {
  provider_subscriptions: { statusCol: "status", label: "subscription" },
  cleaning_subscriptions: { statusCol: "subscription_status", label: "cleaning plan" },
  food_subscriptions: { statusCol: "status", label: "meal plan", extra: { paused_at: null } },
};

providerCustomers.post("/account/providers/:id/subscriptions/:table/:subId/cancel", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const table = c.req.param("table");
  const shape = TABLES[table];
  if (!shape) throw badRequest("Unknown subscription type.");
  const subId = c.req.param("subId");
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(subId)) throw notFound("Subscription not found.");
  const body = await c.req.json().catch(() => ({})) as { reason?: unknown; refund?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const askRefund = body.refund === true;

  const { data: sub } = await db().from(table)
    .select(`id,user_id,provider_id,end_date,payment_status,${shape.statusCol}`).eq("id", subId).maybeSingle();
  if (!sub) throw notFound("Subscription not found.");
  // The row must belong to THIS business — the legacy tables key it by their own id.
  const owner = await universalProviderId(table, (sub as any).provider_id);
  if (owner !== providerId) throw forbidden("That subscription belongs to another business.");
  if (String((sub as any)[shape.statusCol]) === "cancelled") return c.json({ ok: true, already: true });

  const { error } = await db().from(table).update({
    [shape.statusCol]: "cancelled",
    updated_at: new Date().toISOString(),
    ...(shape.extra ?? {}),
  }).eq("id", subId);
  if (error) throw new HttpError(503, "Could not cancel the subscription.");

  const audience = await providerAudience(providerId);
  const name = audience?.name ?? "The business";
  const customerId = (sub as any).user_id ? String((sub as any).user_id) : null;

  // The customer hears it from us, with the reason the business gave.
  if (customerId && UUID_RE.test(customerId)) {
    await notifyUser({
      recipientUserId: customerId, category: "subscription", type: "plan_cancelled",
      title: `${name} cancelled your ${shape.label}`,
      body: `${reason ? `${reason} ` : ""}${askRefund ? "A refund has been requested for you — EverySub will be in touch." : "Write to EverySub support if you have questions."}`,
      relatedEntityType: table, relatedEntityId: subId, actionUrl: "/my-subscriptions",
    });
    const { data: u } = await db().from("users").select("email").eq("id", customerId).maybeSingle();
    if (u?.email) {
      await sendMail({
        to: String(u.email),
        subject: `${name} cancelled your ${shape.label}`,
        text: `${name} cancelled your ${shape.label} on EverySub.${reason ? `\nReason: ${reason}` : ""}\n${askRefund ? "A refund has been requested for you; EverySub will be in touch." : "Questions? Reply to this email."}`,
        html: `<p><strong>${escapeHtml(name)}</strong> cancelled your ${escapeHtml(shape.label)} on EverySub.</p>${reason ? `<p>Reason: ${escapeHtml(reason)}</p>` : ""}<p>${askRefund ? "A refund has been requested for you; EverySub will be in touch." : "Questions? Reply to this email."}</p>`,
      }).catch((e) => console.warn(`[provider-cancel] mail: ${(e as Error).message}`));
    }
  }

  // A refund moves money, so it stays with EverySub: the admins get the request.
  if (askRefund) {
    const admins = await superAdminIds();
    await Promise.all(admins.map((id) => notifyUser({
      recipientUserId: id, category: "business", type: "refund_requested",
      title: `Refund requested · ${name}`,
      body: `${name} cancelled a ${shape.label} (${(sub as any).payment_status ?? "unknown"} payment) and asks for a refund.${reason ? ` Reason: ${reason}` : ""}`,
      relatedEntityType: table, relatedEntityId: subId,
      actionUrl: `/admin/marketplace/subscriptions?q=${encodeURIComponent(subId)}`,
    })));
  }
  return c.json({ ok: true, refundRequested: askRefund });
});

// ── Message active subscribers ───────────────────────────────────────────────

providerCustomers.post("/account/providers/:id/broadcast", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const body = await c.req.json().catch(() => ({})) as { subject?: unknown; message?: unknown };
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 120) : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (subject.length < 3 || message.length < 10) throw badRequest("Write a subject and a message.");

  // One a day — a channel customers can trust not to become spam.
  const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
  const { data: recent, error: logErr } = await db().from("provider_broadcasts")
    .select("id").eq("provider_id", providerId).gte("created_at", since).limit(1);
  if (logErr) throw new HttpError(503, "Messaging isn't switched on yet.");
  if (recent?.length) throw new HttpError(429, "You already messaged your subscribers today. Try again tomorrow.");

  const { data: subs } = await db().from("subscriptions_unified")
    .select("user_id").eq("provider_id", providerId).eq("status", "active").eq("paid", true);
  const userIds = [...new Set((subs ?? []).map((s) => String(s.user_id ?? "")).filter((id) => UUID_RE.test(id)))];
  if (!userIds.length) throw badRequest("You have no active subscribers to message yet.");

  const audience = await providerAudience(providerId);
  const name = audience?.name ?? "Your provider";
  const { data: users } = await db().from("users").select("id,email").in("id", userIds);

  await Promise.all(userIds.map((id) => notifyUser({
    recipientUserId: id, category: "announcement", type: "provider_broadcast",
    title: `${name}: ${subject}`, body: message,
    relatedEntityType: "provider", relatedEntityId: providerId, actionUrl: "/my-subscriptions",
    metadata: { provider_id: providerId },
  })));
  let emailed = 0;
  for (const u of users ?? []) {
    if (!u.email) continue;
    try {
      await sendMail({
        to: String(u.email),
        subject: `${name}: ${subject}`,
        text: `${message}\n\n— ${name}, via EverySub\n${appUrl()}/my-subscriptions`,
        html: `<p style="white-space:pre-wrap">${escapeHtml(message)}</p><p style="color:#666">— ${escapeHtml(name)}, via EverySub</p>`,
      });
      emailed++;
    } catch (e) { console.warn(`[broadcast] ${u.email}: ${(e as Error).message}`); }
  }
  await db().from("provider_broadcasts").insert({
    provider_id: providerId, sent_by: UUID_RE.test(user.id) ? user.id : null, subject, body: message, recipients: userIds.length,
  });
  return c.json({ ok: true, recipients: userIds.length, emailed });
});

// ── Clients who came through the business's code ─────────────────────────────

providerCustomers.get("/account/providers/:id/clients", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const { data, error } = await db().from("provider_clients")
    .select("user_id,created_at").eq("provider_id", providerId).order("created_at", { ascending: false }).limit(200);
  if (error) throw new HttpError(503, "Could not read your clients.");
  const ids = (data ?? []).map((r) => String(r.user_id)).filter((id) => UUID_RE.test(id));
  const { data: users } = ids.length ? await db().from("users").select("id,display_name,name").in("id", ids) : { data: [] as any[] };
  const nameOf = new Map((users ?? []).map((u: any) => [String(u.id), u.display_name || u.name || "Customer"]));
  return c.json({
    count: data?.length ?? 0,
    clients: (data ?? []).slice(0, 20).map((r) => ({ name: nameOf.get(String(r.user_id)) ?? "Customer", since: r.created_at })),
  });
});

// ── Reply to a review ────────────────────────────────────────────────────────

providerCustomers.post("/account/providers/:id/reviews/:reviewId/reply", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertRuns(user.id, providerId, user.roles);
  const reviewId = c.req.param("reviewId");
  if (!UUID_RE.test(reviewId)) throw notFound("Review not found.");
  const body = await c.req.json().catch(() => ({})) as { reply?: unknown };
  const reply = typeof body.reply === "string" ? body.reply.trim().slice(0, 1000) : "";

  const { data: review } = await db().from("provider_reviews").select("id,provider_id,user_id").eq("id", reviewId).maybeSingle();
  if (!review || String(review.provider_id) !== providerId) throw notFound("Review not found.");

  const { error } = await db().from("provider_reviews").update({
    reply: reply || null,
    reply_at: reply ? new Date().toISOString() : null,
    reply_by: reply && UUID_RE.test(user.id) ? user.id : null,
  }).eq("id", reviewId);
  if (error) throw new HttpError(503, /reply/.test(error.message) ? "Replies aren't switched on yet." : "Could not save the reply.");

  if (reply && review.user_id && UUID_RE.test(String(review.user_id))) {
    const audience = await providerAudience(providerId);
    await notifyUser({
      recipientUserId: String(review.user_id), category: "announcement", type: "review_reply",
      title: `${audience?.name ?? "The business"} replied to your review`,
      body: reply.slice(0, 200),
      relatedEntityType: "provider_review", relatedEntityId: reviewId,
      actionUrl: null,
    });
  }
  return c.json({ ok: true });
});

