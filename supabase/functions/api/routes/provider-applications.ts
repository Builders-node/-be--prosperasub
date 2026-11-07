import { Hono } from "hono";
import { requireAccount, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, HttpError, notFound } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { notifyUser } from "../lib/notify.ts";
import { appUrl, superAdminIds } from "../lib/providerAudience.ts";

/**
 * Applications to sell on EverySub — moved off the browser.
 *
 * The table was `FOR ALL TO public USING (true)`: anyone holding the public key
 * could read every applicant's email and phone, edit or delete other people's
 * applications, and file one in someone else's name (the browser sent
 * `user_id`). Now the applicant is whoever the token says, one open
 * application at a time, and the admins hear about it the moment it lands.
 */
export const providerApplications = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Archetypes whose bespoke legacy page lists only its own tables: a provider
 * approved under them would be invisible (how Massage vanished under
 * Lifestyle). Food and cleaning DO get a legacy row on approval.
 */
const LEGACY_WITH_PROVIDER_TABLE = new Set(["food", "cleaning"]);

const PUBLIC_COLS = "id,service,archetype_key,unit,business_name,contact_email,contact_phone,residence,description,status,review_notes,created_provider_id,created_at";

/** Which archetypes a new business may apply under — the page reads this too. */
async function appliableArchetypes() {
  const { data } = await db().from("service_archetypes")
    .select("key,label,description,icon,sort_order,source_service_key").eq("is_active", true).order("sort_order");
  return (data ?? []).filter((a) => !a.source_service_key || LEGACY_WITH_PROVIDER_TABLE.has(a.source_service_key));
}

providerApplications.get("/provider-applications/options", async (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ archetypes: await appliableArchetypes() });
});

providerApplications.get("/account/provider-applications", async (c) => {
  const user = await requireAccount(c);
  // Older rows may carry the token's raw subject (a Google `google-…` id).
  const ids = [...new Set([user.id, user.sub].filter(Boolean))];
  const { data, error } = await db().from("provider_applications").select(PUBLIC_COLS)
    .in("user_id", ids).order("created_at", { ascending: false });
  if (error) throw new HttpError(503, "Could not read your applications.");
  return c.json(data ?? []);
});

providerApplications.post("/account/provider-applications", async (c) => {
  const user = await requireAccount(c);
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const businessName = str(b.businessName, 80);
  if (businessName.length < 2) throw badRequest("What's the business called?");
  const contactPhone = str(b.contactPhone, 40);
  if ((contactPhone.match(/\d/g) ?? []).length < 7) throw badRequest("Add a WhatsApp or phone number we can reach you on.");
  const contactEmail = str(b.contactEmail, 120) || user.email || "";
  if (!EMAIL_RE.test(contactEmail)) throw badRequest("That email address doesn't look right.");

  // What it sells: a service, a rental company, or "something else".
  const kind = b.kind === "vehicles" ? "vehicles" : b.kind === "other" ? "other" : "service";
  let service = kind;
  let archetypeKey: string | null = null;
  if (kind === "service") {
    const key = str(b.archetypeKey, 40);
    const a = (await appliableArchetypes()).find((x) => x.key === key);
    if (!a) throw badRequest("Pick what you sell.");
    archetypeKey = a.key;
    service = a.source_service_key || a.key;
  }

  const ids = [...new Set([user.id, user.sub].filter(Boolean))];
  const { data: open } = await db().from("provider_applications").select("id")
    .in("user_id", ids).eq("status", "pending").limit(1);
  if (open?.length) throw new HttpError(409, "You already have an application under review — we'll be in touch soon.");

  const { data, error } = await db().from("provider_applications").insert({
    user_id: user.id,
    service,
    archetype_key: archetypeKey,
    unit: kind === "vehicles" ? "vehicles" : "marketplace",
    business_name: businessName,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    residence: str(b.residence, 120) || null,
    description: str(b.description, 1500) || null,
    status: "pending",
  }).select(PUBLIC_COLS).single();
  if (error || !data) throw new HttpError(503, "Could not send the application. Try again in a minute.");

  // The admins hear about it now, not whenever they next open the hub.
  const what = kind === "vehicles" ? "Rental company" : kind === "other" ? "Something else" : (archetypeKey ?? service);
  const admins = await superAdminIds();
  await Promise.all(admins.map((id) => notifyUser({
    recipientUserId: id, category: "business", type: "provider_application_new",
    title: `New application · ${businessName}`,
    body: `${what} · ${contactPhone} · ${contactEmail}`,
    relatedEntityType: "provider_application", relatedEntityId: data.id, actionUrl: "/admin/marketplace/providers/applications",
  }).catch(() => undefined)));
  const { data: adminUsers } = admins.length ? await db().from("users").select("email").in("id", admins) : { data: [] as any[] };
  for (const u of adminUsers ?? []) {
    if (!u.email) continue;
    try {
      await sendMail({
        to: String(u.email),
        subject: `New business application: ${businessName}`,
        text: `${businessName} applied to sell on EverySub.\n\nWhat: ${what}\nWhatsApp: ${contactPhone}\nEmail: ${contactEmail}\n${b.description ? `\n${str(b.description, 1500)}\n` : ""}\nReview: ${appUrl()}/admin/marketplace/providers/applications`,
        html: `<h2>${escapeHtml(businessName)} applied</h2><p>${escapeHtml(what)}<br>WhatsApp: ${escapeHtml(contactPhone)}<br>Email: ${escapeHtml(contactEmail)}</p>${b.description ? `<p style="white-space:pre-wrap">${escapeHtml(str(b.description, 1500))}</p>` : ""}<p><a href="${escapeHtml(appUrl())}/admin/marketplace/providers/applications">Review the application</a></p>`,
      });
    } catch (e) { console.warn(`[application-new] mail ${u.email}: ${(e as Error).message}`); }
  }
  return c.json(data, 201);
});

// ── Admin ────────────────────────────────────────────────────────────────────

providerApplications.get("/admin/provider-applications", async (c) => {
  await requireAdmin(c);
  let q = db().from("provider_applications").select("*").order("created_at", { ascending: false }).limit(1000);
  const id = c.req.query("id");
  if (id) {
    if (!UUID_RE.test(id)) throw notFound("Application not found.");
    q = q.eq("id", id);
  }
  const status = c.req.query("status");
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new HttpError(503, "Could not read applications.");
  return c.json(data ?? []);
});

providerApplications.patch("/admin/provider-applications/:id", async (c) => {
  const admin = await requireAdmin(c);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound("Application not found.");
  const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.status !== undefined) {
    if (!["pending", "approved", "rejected"].includes(String(b.status))) throw badRequest("Unknown status.");
    patch.status = b.status;
    patch.reviewed_by = admin.id;
    patch.reviewed_at = new Date().toISOString();
  }
  if (b.reviewNotes !== undefined) patch.review_notes = typeof b.reviewNotes === "string" ? b.reviewNotes.slice(0, 1000) || null : null;
  // "Something else" gets a service once an admin has made one for it.
  if (b.archetypeKey !== undefined) {
    const a = (await appliableArchetypes()).find((x) => x.key === String(b.archetypeKey));
    if (!a) throw badRequest("Pick a service that takes new businesses.");
    patch.archetype_key = a.key;
    patch.service = a.source_service_key || a.key;
  }
  if (b.createdProviderId !== undefined) {
    if (b.createdProviderId !== null && !UUID_RE.test(String(b.createdProviderId))) throw badRequest("Bad provider id.");
    patch.created_provider_id = b.createdProviderId;
  }
  const { data, error } = await db().from("provider_applications").update(patch).eq("id", id).select("id");
  if (error) throw new HttpError(503, "Could not update the application.");
  if (!data?.length) throw notFound("Application not found.");
  return c.json({ ok: true });
});
