import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { isAllowedOrigin } from "../lib/cors.ts";
import { db } from "../lib/db.ts";
import { forbidden, HttpError, notFound } from "../lib/http.ts";

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
    .select("id,created_at,expires_at,claimed_at,claimed_by,revoked_at")
    .eq("provider_id", provider.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new HttpError(503, "Could not read invites.");
  const last = data?.[0] ?? null;
  const open = !!last && !last.claimed_at && !last.revoked_at && Date.parse(last.expires_at) > Date.now();
  return c.json({ open: open ? { createdAt: last!.created_at, expiresAt: last!.expires_at } : null, last });
});

ownerInvites.post("/admin/providers/:id/owner-invites", async (c) => {
  const admin = await requireOwnerAdmin(c);
  const provider = await readProvider(c.req.param("id"));

  // One open link per business: a new one retires the old.
  const { error: revokeErr } = await db().from("provider_owner_invites")
    .update({ revoked_at: nowIso() })
    .eq("provider_id", provider.id)
    .is("claimed_at", null)
    .is("revoked_at", null);
  if (revokeErr) throw new HttpError(503, "Could not replace the previous link.");

  const token = newToken();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86_400_000).toISOString();
  const { error } = await db().from("provider_owner_invites").insert({
    provider_id: provider.id,
    token_hash: await sha256(token),
    created_by: admin.id,
    expires_at: expiresAt,
  });
  if (error) throw new HttpError(503, "Could not create the link.");

  return c.json({ url: `${siteOrigin(c)}/claim-business?token=${token}`, expiresAt }, 201);
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
    .select("id,provider_id,expires_at,claimed_at,claimed_by,revoked_at")
    .eq("token_hash", await sha256(token))
    .maybeSingle();
  if (error) throw new HttpError(503, "Could not read the link.");
  if (!data) throw notFound("This link is not valid.");
  return data as { id: string; provider_id: string; expires_at: string; claimed_at: string | null; claimed_by: string | null; revoked_at: string | null };
}

const stateOf = (inv: { expires_at: string; claimed_at: string | null; revoked_at: string | null }) =>
  inv.claimed_at ? "claimed" : inv.revoked_at ? "revoked" : Date.parse(inv.expires_at) <= Date.now() ? "expired" : "open";

/** What the link is for — the business name and whether it still works. Holding the token is the access. */
ownerInvites.get("/owner-invites/:token", async (c) => {
  const inv = await readInvite(c.req.param("token"));
  const provider = await readProvider(inv.provider_id);
  return c.json({ state: stateOf(inv), business: { id: provider.id, name: provider.name }, expiresAt: inv.expires_at });
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
  return c.json({ providerId: provider.id, name: provider.name, already: false });
});
