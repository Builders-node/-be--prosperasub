import { db } from "./db.ts";
import { escapeHtml, sendMail } from "./mail.ts";
import { notifyUser } from "./notify.ts";

/**
 * Who hears about a business: the owner (`providers.admin_user_id`), everyone
 * on its team (`provider_members`), and the address it publishes
 * (`contact_email`) — the last so a platform-run business with no owner
 * account is still told. The same people the workspace lets in.
 */
export interface ProviderAudience {
  providerId: string;
  name: string;
  /** Accounts that get the in-app notification. */
  userIds: string[];
  /** Addresses that get the email — deduped, lower-cased. */
  emails: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appUrl(): string {
  return (Deno.env.get("APP_URL") || "https://everysub.net").replace(/\/+$/, "");
}

export async function providerAudience(providerId: string): Promise<ProviderAudience | null> {
  const { data: p } = await db().from("providers")
    .select("id,name,admin_user_id,contact_email").eq("id", providerId).maybeSingle();
  if (!p) return null;

  const userIds = new Set<string>();
  const emails = new Set<string>();
  if (p.admin_user_id) userIds.add(String(p.admin_user_id));
  if (p.contact_email) emails.add(String(p.contact_email).trim().toLowerCase());

  const { data: members } = await db().from("provider_members")
    .select("user_id,user_email").eq("provider_id", providerId);
  for (const m of members ?? []) {
    if (m.user_id && UUID_RE.test(String(m.user_id))) userIds.add(String(m.user_id));
    if (m.user_email) emails.add(String(m.user_email).trim().toLowerCase());
  }
  if (userIds.size) {
    const { data: users } = await db().from("users").select("email").in("id", [...userIds]);
    (users ?? []).forEach((u) => u?.email && emails.add(String(u.email).trim().toLowerCase()));
  }
  return {
    providerId: String(p.id),
    name: String(p.name ?? "Your business"),
    userIds: [...userIds],
    emails: [...emails].filter((e) => e.includes("@")),
  };
}

/**
 * Tell a business something: an in-app notification to every account on it,
 * and one email per address. Best-effort — a failed send is logged, never
 * thrown, because the caller's own work (an order, a cancellation) already
 * happened.
 */
export async function tellProvider(audience: ProviderAudience, msg: {
  type: string;
  title: string;
  body: string;
  /** Rows for the email table: [label, value]. */
  facts?: Array<[string, string | null | undefined]>;
  actionPath?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  email?: boolean;
}) {
  const url = `${appUrl()}${msg.actionPath ?? `/my-provider/${audience.providerId}`}`;
  await Promise.all(audience.userIds.map((id) => notifyUser({
    recipientUserId: id,
    category: "business",
    type: msg.type,
    title: msg.title,
    body: msg.body,
    relatedEntityType: msg.relatedEntityType ?? "provider",
    relatedEntityId: msg.relatedEntityId ?? audience.providerId,
    actionUrl: msg.actionPath ?? `/my-provider/${audience.providerId}`,
    metadata: { provider_id: audience.providerId },
  })));
  if (msg.email === false) return;

  const facts = (msg.facts ?? []).filter(([, v]) => v != null && String(v).trim() !== "") as Array<[string, string]>;
  const text = [msg.body, "", ...facts.map(([k, v]) => `${k}: ${v}`), "", `Open it: ${url}`].join("\n");
  const html = `
    <h2 style="margin:0 0 8px">${escapeHtml(msg.title)}</h2>
    <p>${escapeHtml(msg.body)}</p>
    ${facts.length ? `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">${facts.map(([k, v]) =>
      `<tr><td style="color:#666">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`).join("")}</table>` : ""}
    <p><a href="${escapeHtml(url)}">Open ${escapeHtml(audience.name)} on EverySub</a></p>`;
  await Promise.all(audience.emails.map((to) =>
    sendMail({ to, subject: `${msg.title} · ${audience.name}`, text, html })
      .catch((e) => console.warn(`[provider-mail] ${msg.type} to ${to} failed: ${(e as Error).message}`))));
}

export const usd = (cents: number) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;

/** Platform admins (SUPER_ADMIN), for "a business needs you" alerts. */
export async function superAdminIds(): Promise<string[]> {
  const { data } = await db().from("user_roles").select("user_id,role").in("role", ["super_admin", "SUPER_ADMIN"]);
  return [...new Set((data ?? []).map((r) => String(r.user_id)).filter((id) => UUID_RE.test(id)))];
}

/** Legacy per-service tables key a provider by its OWN id; the universal row points back at it. */
const LEGACY_KEY: Record<string, string> = { food_subscriptions: "food", cleaning_subscriptions: "cleaning" };

export async function universalProviderId(table: string, rawProviderId: string | null | undefined): Promise<string | null> {
  if (!rawProviderId) return null;
  const legacy = LEGACY_KEY[table];
  if (!legacy) return String(rawProviderId);
  const { data } = await db().from("providers").select("id")
    .eq("source_service_key", legacy).eq("source_provider_id", String(rawProviderId)).limit(1).maybeSingle();
  return data?.id ? String(data.id) : null;
}
