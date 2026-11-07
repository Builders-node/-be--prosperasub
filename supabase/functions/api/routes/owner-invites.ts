import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { isAllowedOrigin } from "../lib/cors.ts";
import { db } from "../lib/db.ts";
import { forbidden, HttpError, notFound } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { providerAudience, tellProvider } from "../lib/providerAudience.ts";

/**
 * Hand a business to its owner with a link.
 *
 * The admin makes a link on the business (one open link per business, seven
 * days, single use) and sends it however they talk to that person. Whoever
 * opens it SIGNED IN and presses "Accept" becomes `providers.admin_user_id`.
 * Only sha256(token) is stored, so the table never holds a working link; a new
 * link revokes the previous one.
 *
 * Making a link is a platform-owner action (SUPER_ADMIN on the token), not an
 * RBAC permission: it decides who may withdraw a business's money.
 */
export const ownerInvites = new Hono();

const TTL_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSuperAdmin = (roles: string[]) => roles.some((r) => r === "SUPER_ADMIN" || r === "super_admin");

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function requireOwnerAdmin(c: Context) {
  const user = await requireAccount(c, "Admin access token is required");
  if (!isSuperAdmin(user.roles)) throw forbidden("Only a platform admin can hand a business over.");
  return user;
}

async function readProvider(id: string) {
  if (!UUID_RE.test(id)) throw notFound("Business not found.");
  const { data, error } = await db().from("providers").select("id,name,admin_user_id").eq("id", id).maybeSingle();
  if (error) throw new HttpError(503, "Could not read the business.");
  if (!data) throw notFound("Business not found.");
  return data as { id: string; name: string; admin_user_id: string | null };
}

/** The link points back at the site the admin is using (dev or prod). */
function siteOrigin(c: Context): string {
  const origin = c.req.header("origin");
  return isAllowedOrigin(origin) ? origin : "https://everysub.net";
}

const nowIso = () => new Date().toISOString();

// ── Admin: the open link, make one, revoke it ────────────────────────────────

ownerInvites.get("/admin/providers/:id/owner-invites", async (c) => {
  await requireOwnerAdmin(c);
  const provider = await readProvider(c.req.param("id"));
  const { data, error } = await db().from("provider_owner_invites")
    .select("*")
    .eq("provider_id", provider.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new HttpError(503, "Could not read invites.");
  const last = (data ?? []).find((r) => (r as { kind?: string }).kind !== "member") ?? null;
  const open = !!last && !last.claimed_at && !last.revoked_at && Date.parse(last.expires_at) > Date.now();
  return c.json({ open: open ? { createdAt: last!.created_at, expiresAt: last!.expires_at } : null, last });
});

/**
 * Make (and optionally email) a hand-over link. Exported so an application
 * approval can send one in the same breath. A new link retires the open one.
 */
export async function createOwnerInvite(opts: {
  providerId: string; createdBy: string; origin: string; email?: string | null;
}): Promise<{ url: string; expiresAt: string; emailed: boolean }> {
  const provider = await readProvider(opts.providerId);

  // One open OWNER link per business; team invites are left alone.
  let { error: revokeErr } = await db().from("provider_owner_invites")
    .update({ revoked_at: nowIso() })
    .eq("provider_id", provider.id)
    .is("claimed_at", null)
    .is("revoked_at", null)
    .or("kind.is.null,kind.eq.owner");
  if (revokeErr && /kind/.test(revokeErr.message)) {
    ({ error: revokeErr } = await db().from("provider_owner_invites")
      .update({ revoked_at: nowIso() })
      .eq("provider_id", provider.id).is("claimed_at", null).is("revoked_at", null));
  }
  if (revokeErr) throw new HttpError(503, "Could not replace the previous link.");

  const token = newToken();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86_400_000).toISOString();
  const email = opts.email?.trim().toLowerCase() || null;
  const row: Record<string, unknown> = {
    provider_id: provider.id,
    token_hash: await sha256(token),
    created_by: opts.createdBy,
    expires_at: expiresAt,
  };
  if (email) row.invited_email = email;
  let { error } = await db().from("provider_owner_invites").insert(row);
  // Before migration 20261110120000 the column does not exist — still make the link.
  if (error && email && /invited_email/.test(error.message)) {
    delete row.invited_email;
    ({ error } = await db().from("provider_owner_invites").insert(row));
  }
  if (error) throw new HttpError(503, "Could not create the link.");

  const url = `${opts.origin}/claim-business?token=${token}`;
  let emailed = false;
  if (email) {
    // The business has no address yet (every seeded draft) — the person we are
    // handing it to is the best one we have; calendars are shared with it.
    await db().from("providers").update({ contact_email: email })
      .eq("id", provider.id).or("contact_email.is.null,contact_email.eq.");
    try {
      const r = await sendMail({
        to: email,
        subject: `${provider.name} is ready for you on EverySub`,
        text: [
          `Hi! ${provider.name} has a page on EverySub, the subscription marketplace for Roatán.`,
          "Open this link, sign in (or create an account with this email) and press Accept — the business becomes yours to manage: plans, schedule, team and payouts.",
          "", url, "",
          `The link works once and until ${expiresAt.slice(0, 10)}.`,
        ].join("\n"),
        html: `<h2>${escapeHtml(provider.name)} is ready for you</h2>
          <p>${escapeHtml(provider.name)} has a page on EverySub, the subscription marketplace for Roatán.</p>
          <p>Open the link, sign in (or create an account with this email) and press <strong>Accept</strong> — the business becomes yours to manage: plans, schedule, team and payouts.</p>
          <p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#F5A623;color:#000;text-decoration:none;font-weight:600">Take over ${escapeHtml(provider.name)}</a></p>
          <p style="color:#666">The link works once and until ${expiresAt.slice(0, 10)}.</p>`,
      });
      emailed = !!r.sent;
    } catch (e) {
      console.warn(`[owner-invites] email to ${email} failed: ${(e as Error).message}`);
    }
  }
  return { url, expiresAt, emailed };
}

ownerInvites.post("/admin/providers/:id/owner-invites", async (c) => {
  const admin = await requireOwnerAdmin(c);
  const body = await c.req.json().catch(() => ({})) as { email?: unknown };
  const email = typeof body.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ? body.email : null;
  if (typeof body.email === "string" && body.email.trim() && !email) throw new HttpError(400, "That email address doesn't look right.");
  const r = await createOwnerInvite({ providerId: c.req.param("id"), createdBy: admin.id, origin: siteOrigin(c), email });
  return c.json(r, 201);
});

/** Invite state for every business — the Businesses list shows it. */
ownerInvites.get("/admin/owner-invites", async (c) => {
  await requireOwnerAdmin(c);
  const { data, error } = await db().from("provider_owner_invites")
    .select("*").order("created_at", { ascending: false }).limit(500);
  if (error) throw new HttpError(503, "Could not read invites.");
  const latest = new Map<string, Record<string, unknown>>();
  for (const r of data ?? []) {
    if ((r as { kind?: string }).kind === "member") continue; // team invites aren't ownership
    if (!latest.has(String(r.provider_id))) latest.set(String(r.provider_id), r);
  }
  return c.json([...latest.values()].map((r) => ({
    providerId: r.provider_id,
    state: stateOf(r as { expires_at: string; claimed_at: string | null; revoked_at: string | null }),
    invitedEmail: (r as { invited_email?: string | null }).invited_email ?? null,
    openedAt: (r as { opened_at?: string | null }).opened_at ?? null,
    createdAt: r.created_at,
  })));
});

ownerInvites.delete("/admin/providers/:id/owner-invites", async (c) => {
  await requireOwnerAdmin(c);
  const provider = await readProvider(c.req.param("id"));
  const { error } = await db().from("provider_owner_invites")
    .update({ revoked_at: nowIso() })
    .eq("provider_id", provider.id)
    .is("claimed_at", null)
    .is("revoked_at", null);
  if (error) throw new HttpError(503, "Could not revoke the link.");
  return c.json({ revoked: true });
});

// ── The person with the link ─────────────────────────────────────────────────

async function readInvite(token: string) {
  if (!token || token.length < 20 || token.length > 100) throw notFound("This link is not valid.");
  const { data, error } = await db().from("provider_owner_invites")
    .select("*")
    .eq("token_hash", await sha256(token))
    .maybeSingle();
  if (error) throw new HttpError(503, "Could not read the link.");
  if (!data) throw notFound("This link is not valid.");
  return data as {
    id: string; provider_id: string; expires_at: string; claimed_at: string | null; claimed_by: string | null; revoked_at: string | null;
    /** 'owner' (the default) or 'member' — a team invite (routes/provider-growth.ts). */
    kind?: string | null; invited_email?: string | null;
  };
}

const stateOf = (inv: { expires_at: string; claimed_at: string | null; revoked_at: string | null }) =>
  inv.claimed_at ? "claimed" : inv.revoked_at ? "revoked" : Date.parse(inv.expires_at) <= Date.now() ? "expired" : "open";

/** What the link is for — the business name and whether it still works. Holding the token is the access. */
ownerInvites.get("/owner-invites/:token", async (c) => {
  const inv = await readInvite(c.req.param("token"));
  const provider = await readProvider(inv.provider_id);
  // "Opened" for the admin's list; best-effort (the column arrives with 20261110120000).
  if (stateOf(inv) === "open") {
    await db().from("provider_owner_invites").update({ opened_at: nowIso() }).eq("id", inv.id).is("opened_at", null)
      .then(() => undefined, () => undefined);
  }
  return c.json({ state: stateOf(inv), kind: inv.kind === "member" ? "member" : "owner", business: { id: provider.id, name: provider.name }, expiresAt: inv.expires_at });
});

ownerInvites.post("/owner-invites/:token/claim", async (c) => {
  const user = await requireAccount(c);
  if (!UUID_RE.test(user.id)) throw new HttpError(409, "Your account isn't fully set up yet — sign out and in again, then open the link.");
  const inv = await readInvite(c.req.param("token"));
  const state = stateOf(inv);
  if (state === "claimed" && inv.claimed_by === user.id) {
    const provider = await readProvider(inv.provider_id);
    return c.json({ providerId: provider.id, name: provider.name, already: true });
  }
  if (state !== "open") {
    throw new HttpError(409, state === "expired"
      ? "This link has expired. Ask EverySub for a new one."
      : "This link has already been used or was replaced. Ask EverySub for a new one.");
  }

  // Claim first, guarded on still being open — two people opening one link
  // cannot both become the owner.
  const { data: claimed, error: claimErr } = await db().from("provider_owner_invites")
    .update({ claimed_at: nowIso(), claimed_by: user.id })
    .eq("id", inv.id)
    .is("claimed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso())
    .select("id");
  if (claimErr) throw new HttpError(503, "Could not accept the link.");
  if (!claimed?.length) throw new HttpError(409, "This link has already been used. Ask EverySub for a new one.");

  // A team invite makes a manager, never an owner.
  if (inv.kind === "member") {
    const { data: already } = await db().from("provider_members").select("id")
      .eq("provider_id", inv.provider_id).eq("user_id", user.id).limit(1);
    if (!already?.length) {
      const { data: u } = await db().from("users").select("email,name,display_name").eq("id", user.id).maybeSingle();
      const { error: memErr } = await db().from("provider_members").insert({
        provider_id: inv.provider_id, user_id: user.id,
        user_email: u?.email ?? user.email ?? null, user_name: u?.display_name || u?.name || null, role: "manager",
      });
      if (memErr) {
        await db().from("provider_owner_invites").update({ claimed_at: null, claimed_by: null }).eq("id", inv.id);
        throw new HttpError(503, "Could not add you to the team. Please try again.");
      }
    }
    const provider = await readProvider(inv.provider_id);
    return c.json({ providerId: provider.id, name: provider.name, already: false, kind: "member" });
  }

  const { error: ownErr } = await db().from("providers")
    .update({ admin_user_id: user.id, updated_at: nowIso() })
    .eq("id", inv.provider_id);
  if (ownErr) {
    // Give the link back rather than leave it spent on a business nobody got.
    await db().from("provider_owner_invites").update({ claimed_at: null, claimed_by: null }).eq("id", inv.id);
    throw new HttpError(503, "Could not make you the owner. Please try again.");
  }

  await db().from("admin_audit_logs").insert({
    admin_user_id: user.id, action: "claim_owner", entity_type: "provider", entity_id: inv.provider_id,
    details: { invite_id: inv.id },
  }).then(({ error }) => { if (error) console.warn("[owner-invites] audit log failed", error.message); });

  const provider = await readProvider(inv.provider_id);
  const audience = await providerAudience(provider.id);
  if (audience) {
    await tellProvider({ ...audience, userIds: [user.id], emails: [] }, {
      type: "provider_claimed",
      title: "The business is yours",
      body: `You now own ${provider.name} on EverySub. Finish its profile and plans — the checklist on the Overview shows what is left before it goes live.`,
      email: false,
    });
  }
  return c.json({ providerId: provider.id, name: provider.name, already: false });
});
