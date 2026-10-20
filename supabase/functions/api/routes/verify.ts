import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { HttpError } from "../lib/http.ts";
import { evaluateAccess } from "../lib/membership.ts";
import { validate } from "../lib/validate.ts";

/**
 * Port of backend/src/verify — the profile access QR.
 *
 * Both routes MUST move together: the token is signed with JWT_VERIFY_SECRET,
 * and the Edge one is not the Nest one (Vercel would not hand it back). A
 * token lives five minutes, so a scan in flight at the switch just refreshes.
 */
export const verify = new Hono();

function verifySecret(): Uint8Array {
  const s = Deno.env.get("JWT_VERIFY_SECRET");
  if (!s || s.length < 32) throw new HttpError(503, "Verification is not configured");
  return new TextEncoder().encode(s);
}

verify.post("/verify/token", async (c) => {
  const user = await requireAccount(c);
  const ttl = Number(Deno.env.get("VERIFY_TOKEN_TTL_SECONDS") ?? 300);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ typ: "verify" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(verifySecret());
  return c.json({ token, expires_in: ttl }, 201);
});

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function audit(entry: {
  tokenHash: string | null; userId: string | null; result: "allowed" | "denied" | "invalid_token";
  reason: string; allowed: boolean; count: number; ip: string | null; userAgent: string | null;
}) {
  const { error } = await db().from("access_verification_logs").insert({
    token_hash: entry.tokenHash, user_id: entry.userId, result: entry.result, reason: entry.reason,
    allowed: entry.allowed, subscription_count: entry.count, ip: entry.ip, user_agent: entry.userAgent,
  });
  if (error) console.warn(`[verify.log] failed: ${error.message}`);
}

/** Court hours still ahead, for the door person ("Tennis Court 2, 4–5pm"). Best-effort. */
async function upcomingBookings(userId: string) {
  const todayHn = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
  const { data, error } = await db()
    .from("bookings")
    .select("id,resource_id,start_at,end_at,status")
    .eq("subject_ref", `user:${userId}`)
    .in("status", ["held", "confirmed", "completed", "no_show"])
    .gte("start_at", `${todayHn}T00:00:00Z`)
    .order("start_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const resourceIds = [...new Set((data ?? []).map((b) => b.resource_id))];
  const names = new Map<string, string>();
  if (resourceIds.length) {
    const { data: res } = await db().from("bookable_resources").select("id,name").in("id", resourceIds);
    for (const r of res ?? []) names.set(String(r.id), String(r.name));
  }
  const now = Date.now();
  return (data ?? [])
    .filter((b) => ["held", "confirmed"].includes(String(b.status)))
    .filter((b) => new Date(b.end_at).getTime() >= now)
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
    .slice(0, 5)
    .map((b) => ({
      id: String(b.id), resource_name: names.get(String(b.resource_id)) ?? null,
      start_at: new Date(b.start_at).toISOString(), end_at: new Date(b.end_at).toISOString(), status: String(b.status),
    }));
}

verify.post("/verify-access", async (c) => {
  const { token } = validate<{ token: string }>(await c.req.json().catch(() => ({})), { token: { type: "string" } });
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = c.req.header("user-agent") ?? null;
  const tokenHash = token ? await sha256Hex(token) : null;
  const empty = { user: null, subscriptions: [], bookings: [] };

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, verifySecret(), { algorithms: ["HS256"] });
    if (payload.typ !== "verify" || !payload.sub) throw new Error("typ");
    userId = payload.sub;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const reason = "Invalid or expired QR code";
    await audit({ tokenHash, userId: null, result: "invalid_token", reason, allowed: false, count: 0, ip, userAgent });
    return c.json({ ok: false, allowed: false, reason, ...empty }, 201);
  }

  const { data: u } = await db().from("users").select("id,name,display_name,avatar_url").eq("id", userId).limit(1).maybeSingle();
  if (!u) {
    const reason = "User not found";
    await audit({ tokenHash, userId, result: "denied", reason, allowed: false, count: 0, ip, userAgent });
    return c.json({ ok: false, allowed: false, reason, ...empty }, 201);
  }
  const user = { id: String(u.id), name: (u.display_name || u.name || "Unknown user") as string, avatar_url: (u.avatar_url ?? null) as string | null };

  const { permit: allowed, reason, subscriptions } = await evaluateAccess(userId);
  const bookings = await upcomingBookings(userId).catch((err) => {
    console.warn(`verify: could not load bookings for ${userId} — ${String(err)}`);
    return [];
  });
  await audit({ tokenHash, userId, result: allowed ? "allowed" : "denied", reason, allowed, count: subscriptions.length, ip, userAgent });
  return c.json({ ok: true, allowed, reason, user, subscriptions, bookings }, 201);
});
