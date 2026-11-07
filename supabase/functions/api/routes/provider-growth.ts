import { Hono } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { isAllowedOrigin } from "../lib/cors.ts";
import { db } from "../lib/db.ts";
import { badRequest, forbidden, HttpError, notFound } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { appUrl, providerAudience } from "../lib/providerAudience.ts";

/**
 * A business growing itself: its own promo codes, and its team.
 *
 * Promo codes were admin-only although the table always had `provider_id`;
 * a code made here is forced to the caller's business, so the discount can
 * only ever apply to its own plans. Team members had to have an account
 * already; an email with no account now gets an invite link (the owner-invite
 * mechanics, kind = 'member').
 */
export const providerGrowth = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

/** Owner (or admin). Promo codes cost the business money; team decides who sees addresses. */
async function assertOwner(userId: string, providerId: string, roles: string[]) {
  if (!UUID_RE.test(providerId)) throw notFound("Business not found.");
  if (isSuperAdmin(roles)) return;
  const { data: p } = await db().from("providers").select("admin_user_id").eq("id", providerId).maybeSingle();
  if (!p) throw notFound("Business not found.");
  if (!p.admin_user_id || String(p.admin_user_id) !== String(userId)) {
    throw forbidden("Only the owner of this business can do that.");
  }
}

// ── Promo codes ──────────────────────────────────────────────────────────────

providerGrowth.get("/account/providers/:id/promo-codes", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user.id, providerId, user.roles);
  const { data, error } = await db().from("promo_codes")
    .select("id,code,description,kind,percent_off,amount_off_cents,min_order_cents,max_redemptions,ends_at,status,created_at")
    .eq("provider_id", providerId).order("created_at", { ascending: false });
  if (error) throw new HttpError(503, "Could not read your codes.");
  return c.json(data ?? []);
});

providerGrowth.post("/account/providers/:id/promo-codes", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user.id, providerId, user.roles);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw badRequest("A code is 3–24 letters or digits, no spaces.");
  const kind = b.kind === "fixed" ? "fixed" : "percent";
  const value = Number(b.value);
  if (kind === "percent" && !(value >= 1 && value <= 90)) throw badRequest("A percentage is between 1 and 90.");
  if (kind === "fixed" && !(value >= 1 && value <= 10_000)) throw badRequest("An amount off is between $1 and $10,000.");
  const endsAt = typeof b.endsAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.endsAt) ? `${b.endsAt}T23:59:59-06:00` : null;
  const maxRedemptions = Number.isInteger(Number(b.maxRedemptions)) && Number(b.maxRedemptions) > 0 ? Number(b.maxRedemptions) : null;

  const { data, error } = await db().from("promo_codes").insert({
    code,
    description: typeof b.description === "string" ? b.description.trim().slice(0, 200) || null : null,
    kind,
    percent_off: kind === "percent" ? Math.round(value) : null,
    amount_off_cents: kind === "fixed" ? Math.round(value * 100) : null,
    provider_id: providerId,
    max_redemptions: maxRedemptions,
    per_customer_limit: 1,
    ends_at: endsAt,
    status: "active",
    created_by: UUID_RE.test(user.id) ? user.id : null,
  }).select("id").single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw new HttpError(409, "That code is taken — try another.");
    throw new HttpError(503, "Could not create the code.");
  }
  return c.json({ id: data?.id }, 201);
});

providerGrowth.patch("/account/providers/:id/promo-codes/:codeId", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user.id, providerId, user.roles);
  const codeId = c.req.param("codeId");
  if (!UUID_RE.test(codeId)) throw notFound("Code not found.");
  const b = await c.req.json().catch(() => ({})) as { status?: unknown };
  if (b.status !== "active" && b.status !== "inactive") throw badRequest("status is active or inactive");
  const { data, error } = await db().from("promo_codes").update({ status: b.status, updated_at: new Date().toISOString() })
    .eq("id", codeId).eq("provider_id", providerId).select("id");
  if (error) throw new HttpError(503, "Could not update the code.");
  if (!data?.length) throw notFound("Code not found.");
  return c.json({ ok: true });
});

// ── Team: add by email, invite if there is no account yet ────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

providerGrowth.post("/account/providers/:id/team-invites", async (c) => {
  const user = await requireAccount(c);
  const providerId = c.req.param("id");
  await assertOwner(user.id, providerId, user.roles);
  const b = await c.req.json().catch(() => ({})) as { email?: unknown; name?: unknown };
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("That email address doesn't look right.");
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) || null : null;

  // Someone with an account joins at once.
  const { data: existing } = await db().from("users").select("id,email,name").eq("email", email).limit(1).maybeSingle();
  if (existing?.id) {
    const { data: already } = await db().from("provider_members").select("id").eq("provider_id", providerId).eq("user_id", existing.id).limit(1);
    if (!already?.length) {
      const { error } = await db().from("provider_members").insert({
        provider_id: providerId, user_id: existing.id, user_email: email, user_name: name || existing.name || null, role: "manager",
      });
      if (error) throw new HttpError(503, "Could not add them.");
    }
    return c.json({ added: true, invited: false });
  }

  // Nobody yet: a link, by email, that makes them a manager when they accept.
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const { error } = await db().from("provider_owner_invites").insert({
    provider_id: providerId, token_hash: await sha256(token), created_by: user.id,
    expires_at: expiresAt, invited_email: email, kind: "member",
  });
  if (error) throw new HttpError(503, /kind/.test(error.message) ? "Team invites aren't switched on yet." : "Could not create the invite.");

  const audience = await providerAudience(providerId);
  const bizName = audience?.name ?? "a business";
  const origin = isAllowedOrigin(c.req.header("origin")) ? c.req.header("origin")! : appUrl();
  const url = `${origin}/claim-business?token=${token}`;
  let emailed = false;
  try {
    const r = await sendMail({
      to: email,
      subject: `Join ${bizName} on EverySub`,
      text: `You're invited to help run ${bizName} on EverySub — its schedule, customers and plans.\n\nOpen the link, sign in (or create an account with this email) and accept:\n${url}\n\nThe link works once and for 14 days.`,
      html: `<h2>Join ${escapeHtml(bizName)} on EverySub</h2><p>You're invited to help run ${escapeHtml(bizName)} — its schedule, customers and plans.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#F5A623;color:#000;text-decoration:none;font-weight:600">Accept the invite</a></p><p style="color:#666">The link works once and for 14 days.</p>`,
    });
    emailed = !!r.sent;
  } catch (e) {
    console.warn(`[team-invite] ${email}: ${(e as Error).message}`);
  }
  return c.json({ added: false, invited: true, emailed, url });
});
