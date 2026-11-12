import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccount } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { badRequest, unauthorized } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { notifyUser } from "../lib/notify.ts";

/**
 * Reminders — before every visit, delivery, booking or pickup, whatever the
 * service (migration 20261125120000).
 *
 *   GET  /account/preferences/reminders   the customer's settings
 *   PUT  /account/preferences/reminders   {reminder_enabled, reminder_method,
 *                                          reminder_minutes_before,
 *                                          access_instructions, reminder_services}
 *        (/account/preferences/cleaning is the same thing under its old name)
 *   POST /cron/reminders                  pg_cron, every 10 minutes
 *
 * The source is service_occurrences — the one table of things that happen at
 * a time. A reminder is claimed in occurrence_reminders BEFORE it is sent, so
 * two overlapping runs can never send it twice.
 */
export const reminders = new Hono();

const TZ = "America/Tegucigalpa";
const METHODS = ["all", "email", "in_app"];
const LOOKAHEAD_MS = 25 * 3_600_000;

interface Prefs {
  reminder_enabled: boolean;
  reminder_method: string;
  reminder_minutes_before: number;
  access_instructions: string | null;
  /** Archetype keys; null = every service. */
  reminder_services: string[] | null;
}
const DEFAULTS: Prefs = {
  reminder_enabled: true, reminder_method: "all", reminder_minutes_before: 60,
  access_instructions: null, reminder_services: null,
};

const shape = (r: Record<string, any> | null | undefined): Prefs => r ? {
  reminder_enabled: r.reminder_enabled ?? true,
  reminder_method: METHODS.includes(r.reminder_method) ? r.reminder_method : "all",
  reminder_minutes_before: Number(r.reminder_minutes_before) || 60,
  access_instructions: r.access_instructions ?? null,
  reminder_services: Array.isArray(r.reminder_services) ? r.reminder_services : null,
} : { ...DEFAULTS };

async function readPrefs(c: Context) {
  const user = await requireAccount(c);
  const { data } = await db().from("user_cleaning_preferences").select("*").eq("user_id", user.id).maybeSingle();
  return c.json(shape(data));
}

async function writePrefs(c: Context) {
  const user = await requireAccount(c);
  const b = await c.req.json().catch(() => ({})) as Record<string, any>;
  const minutes = Math.round(Number(b.reminder_minutes_before ?? 60));
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 1440) throw badRequest("Choose when to be reminded.");
  const services = b.reminder_services === null || b.reminder_services === undefined
    ? null
    : Array.isArray(b.reminder_services)
      ? [...new Set(b.reminder_services.map((s: unknown) => String(s)).filter((s: string) => /^[a-z0-9_-]{1,40}$/.test(s)))]
      : null;
  const row = {
    user_id: user.id,
    reminder_enabled: b.reminder_enabled !== false,
    reminder_method: METHODS.includes(b.reminder_method) ? b.reminder_method : "all",
    reminder_minutes_before: minutes,
    access_instructions: String(b.access_instructions ?? "").trim().slice(0, 500) || null,
    reminder_services: services,
    updated_at: new Date().toISOString(),
  };
  let { error } = await db().from("user_cleaning_preferences").upsert(row, { onConflict: "user_id" });
  // Before the migration the services column is not there — save the rest.
  if (error && /reminder_services/.test(error.message)) {
    const { reminder_services: _drop, ...rest } = row;
    ({ error } = await db().from("user_cleaning_preferences").upsert(rest, { onConflict: "user_id" }));
  }
  if (error) throw badRequest(error.message);
  return c.json(shape(row));
}

reminders.get("/account/preferences/reminders", readPrefs);
reminders.put("/account/preferences/reminders", writePrefs);
reminders.get("/account/preferences/cleaning", readPrefs);
reminders.put("/account/preferences/cleaning", writePrefs);

// ── The clock ────────────────────────────────────────────────────────────────

async function requireCronKey(c: Context) {
  const key = c.req.header("x-cron-key");
  if (!key) throw unauthorized("Cron key required");
  const { data, error } = await db().rpc("cron_key_matches", { p_name: "reminders_key", p_key: key });
  if (error || data !== true) throw unauthorized("Bad cron key");
}

const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
function whenText(at: Date, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(at);
  const d = dayOf(at);
  if (d === dayOf(now)) return `today at ${time}`;
  if (d === dayOf(new Date(now.getTime() + 86_400_000))) return `tomorrow at ${time}`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(at);
  return `${day} at ${time}`;
}
/** A few occurrence keys read badly as words. */
const KEY_WORDS: Record<string, string> = { handover: "Vehicle pickup", return: "Vehicle return" };
const tidy = (k: string | null | undefined) => (k && KEY_WORDS[k]) ? KEY_WORDS[k] : (k ? k.replace(/[_-]+/g, " ").replace(/^\w/, (x) => x.toUpperCase()) : null);

reminders.post("/cron/reminders", async (c) => {
  await requireCronKey(c);
  const now = new Date();
  const until = new Date(now.getTime() + LOOKAHEAD_MS);

  const { data: occ, error } = await db().from("service_occurrences")
    // No embed: service_occurrences has no foreign key to providers, so
    // PostgREST cannot join them — the businesses are read separately below.
    .select("id,user_id,provider_id,item_key,starts_at,access_instructions,source_service_key")
    .eq("status", "scheduled").not("user_id", "is", null)
    .gt("starts_at", now.toISOString()).lte("starts_at", until.toISOString())
    .order("starts_at").limit(1000);
  if (error) throw badRequest(error.message);
  const rows = (occ ?? []) as any[];
  if (!rows.length) return c.json({ checked: 0, sent: 0 });

  const ids = rows.map((r) => r.id);
  const { data: done } = await db().from("occurrence_reminders").select("occurrence_id").in("occurrence_id", ids);
  const reminded = new Set((done ?? []).map((r: any) => r.occurrence_id));

  const providerIds = [...new Set(rows.map((r) => r.provider_id).filter(Boolean).map(String))];
  const { data: provs } = providerIds.length
    ? await db().from("providers").select("id,name,archetype_key").in("id", providerIds)
    : { data: [] as any[] };
  const providerOf = new Map((provs ?? []).map((p: any) => [String(p.id), p]));
  for (const r of rows) r.providers = providerOf.get(String(r.provider_id)) ?? null;

  const userIds = [...new Set(rows.map((r) => String(r.user_id)))];
  const [{ data: prefRows }, { data: users }, { data: archetypes }] = await Promise.all([
    db().from("user_cleaning_preferences").select("*").in("user_id", userIds),
    db().from("users").select("id,email,name,display_name").in("id", userIds),
    db().from("service_archetypes").select("key,label"),
  ]);
  const prefsOf = new Map((prefRows ?? []).map((p: any) => [String(p.user_id), shape(p)]));
  const userOf = new Map((users ?? []).map((u: any) => [String(u.id), u]));
  const labelOf = new Map((archetypes ?? []).map((a: any) => [String(a.key), String(a.label)]));

  let sent = 0, skipped = 0;
  for (const o of rows) {
    if (reminded.has(o.id)) continue;
    const uid = String(o.user_id);
    const prefs = prefsOf.get(uid) ?? DEFAULTS;
    const arch = o.providers?.archetype_key ?? o.source_service_key ?? null;
    if (!prefs.reminder_enabled || (prefs.reminder_services && arch && !prefs.reminder_services.includes(arch))) { skipped++; continue; }
    const at = new Date(o.starts_at);
    if (at.getTime() - prefs.reminder_minutes_before * 60_000 > now.getTime()) continue; // not yet

    // Claim first: a second run that gets here finds the row and stops.
    const { error: claimErr } = await db().from("occurrence_reminders").insert({ occurrence_id: o.id, user_id: uid });
    if (claimErr) continue;

    // "Lunch today at 12:30 PM", "Tennis Court 1 tomorrow at 9:00 AM",
    // "Cleaning today at 2:00 PM" — the occurrence's own word, else its service.
    const service = arch ? labelOf.get(arch) ?? tidy(arch) : null;
    const what = tidy(o.item_key) ?? service ?? "Your booking";
    const title = `${what} ${whenText(at, now)}`;
    const note = o.access_instructions || prefs.access_instructions;
    const body = [o.providers?.name, note ? `Note: ${note}` : null].filter(Boolean).join(" · ") || "See it in My subscriptions.";
    const methods: string[] = [];

    if (prefs.reminder_method !== "email") {
      await notifyUser({
        recipientUserId: uid, category: "reminder", type: "reminder_occurrence",
        title, body, relatedEntityType: "service_occurrences", relatedEntityId: o.id, actionUrl: "/my-subscriptions",
      });
      methods.push("in_app");
    }
    const user = userOf.get(uid);
    if (prefs.reminder_method !== "in_app" && user?.email) {
      const name = user.display_name || user.name || "";
      const html = `<p>${name ? `Hi ${escapeHtml(name)},` : "Hi,"}</p>`
        + `<p><strong>${escapeHtml(title)}</strong></p>`
        + `<p>${escapeHtml(body)}</p>`
        + `<p style="color:#888;font-size:13px">You can change or turn off reminders in your EverySub profile → Reminders.</p>`;
      try {
        await sendMail({ to: user.email, subject: title, html, text: `${title}\n\n${body}\n\nChange reminders: your EverySub profile → Reminders.` });
        methods.push("email");
      } catch (e) {
        console.warn(`[reminders] email to ${uid} failed: ${(e as Error).message}`);
      }
    }
    await db().from("occurrence_reminders").update({ methods }).eq("occurrence_id", o.id);
    sent++;
  }
  return c.json({ checked: rows.length, sent, skipped });
});
