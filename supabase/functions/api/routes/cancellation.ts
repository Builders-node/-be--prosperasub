import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { notifyUser } from "../lib/notify.ts";
import { paypal } from "../lib/paypal.ts";

/**
 * Port of AccountCancellationService (backend/src/account): cancel = "won't
 * renew, keep it until end_date"; resume = undo while the period runs.
 *
 * New on Edge: a membership PayPal renews by itself is SUSPENDED at PayPal on
 * cancel and re-activated on resume. Without that, "Cancel" here would flip
 * our flag while PayPal kept charging every month.
 */
export const cancellation = new Hono();

interface Shape { table: string; statusCol: string; cancellable: string[]; label: string }
const SERVICES: Record<string, Shape> = {
  cleaning: { table: "cleaning_subscriptions", statusCol: "subscription_status", cancellable: ["active", "pending_schedule", "paused"], label: "cleaning plan" },
  food: { table: "food_subscriptions", statusCol: "status", cancellable: ["active", "paused"], label: "meal plan" },
  beach: { table: "provider_subscriptions", statusCol: "status", cancellable: ["active", "paused"], label: "membership" },
  plan: { table: "provider_subscriptions", statusCol: "status", cancellable: ["active", "paused"], label: "subscription" },
};

async function setFlag(c: any, cancel: boolean) {
  const user = await requireAccount(c);
  const service = c.req.param("service");
  const id = c.req.param("id");
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(id)) throw notFound("Subscription not found.");
  const shape = SERVICES[service];
  if (!shape) throw badRequest(`Unknown service "${service}".`);
  const paypalCols = shape.table === "provider_subscriptions" ? ",paypal_subscription_id,auto_renew" : "";
  const { data: sub, error } = await db().from(shape.table)
    .select(`id,user_id,end_date,cancel_at_period_end,${shape.statusCol}${paypalCols}`)
    // Beach cards still hand out the legacy id; the universal row carries it.
    .or(service === "beach" ? `id.eq.${id},source_subscription_id.eq.${id}` : `id.eq.${id}`)
    .limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!sub) throw notFound("Subscription not found.");

  // Ownership: the row records the canonical users.id; a Google login's token
  // carries google-…, resolved by email in requireAccount.
  let owns = String(sub.user_id ?? "") === String(user.id);
  if (!owns && user.email) {
    const { data: u } = await db().from("users").select("id").eq("email", user.email).limit(1).maybeSingle();
    owns = !!u?.id && String(sub.user_id ?? "") === String(u.id);
  }
  if (!owns) throw forbidden("This subscription is not yours.");

  const status = String((sub as Record<string, unknown>)[shape.statusCol] ?? "").toLowerCase();
  if (cancel && !shape.cancellable.includes(status)) {
    throw badRequest(status === "cancelled" || status === "expired"
      ? "This subscription has already ended."
      : `A ${status} subscription can't be cancelled.`);
  }
  if (Boolean(sub.cancel_at_period_end) === cancel) {
    return c.json({ ok: true, cancelAtPeriodEnd: cancel, endsOn: sub.end_date ?? null }, 201);
  }

  // PayPal first: if PayPal refuses, our flag must not claim billing stopped.
  const ppId = (sub as { paypal_subscription_id?: string | null }).paypal_subscription_id;
  let autoRenew: boolean | undefined;
  if (ppId) {
    const remote = await paypal<{ status?: string }>(`/v1/billing/subscriptions/${encodeURIComponent(ppId)}`);
    if (cancel && remote.status === "ACTIVE") {
      await paypal(`/v1/billing/subscriptions/${encodeURIComponent(ppId)}/suspend`, {
        method: "POST", body: { reason: "Cancelled by the customer on EverySub" },
      });
      autoRenew = false;
    } else if (!cancel && remote.status === "SUSPENDED") {
      await paypal(`/v1/billing/subscriptions/${encodeURIComponent(ppId)}/activate`, {
        method: "POST", body: { reason: "Resumed by the customer on EverySub" },
      });
      autoRenew = true;
    }
  }

  const { error: upErr } = await db().from(shape.table).update({
    cancel_at_period_end: cancel,
    cancel_requested_at: cancel ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    ...(autoRenew !== undefined ? { auto_renew: autoRenew } : {}),
  }).eq("id", sub.id);
  if (upErr) throw new HttpError(503, "Could not update the subscription.");

  await notifyUser({
    recipientUserId: String(sub.user_id),
    category: "subscription",
    type: cancel ? "plan_cancelled" : "subscription_created",
    title: cancel ? "Subscription cancelled" : "Subscription resumed",
    body: cancel
      ? sub.end_date
        ? `Your ${shape.label} won't renew. You can keep using it until ${sub.end_date}, and you can undo this until then.`
        : `Your ${shape.label} won't renew.`
      : `Your ${shape.label} will renew as usual.`,
    relatedEntityType: shape.table,
    relatedEntityId: String(sub.id),
    actionUrl: "/my-subscriptions",
  });
  return c.json({ ok: true, cancelAtPeriodEnd: cancel, endsOn: sub.end_date ?? null }, 201);
}

cancellation.post("/account/:service/subscriptions/:id/cancel", (c) => setFlag(c, true));
cancellation.post("/account/:service/subscriptions/:id/resume", (c) => setFlag(c, false));
