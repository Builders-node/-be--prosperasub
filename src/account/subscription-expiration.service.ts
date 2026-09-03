import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "../mail/mail.service";
import { AccountNotificationsService, NotificationType } from "./account-notifications.service";
import { publicAppUrl } from "../config/app-origins";
import { APP_BRAND_NAME } from "../config/branding";

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/Tegucigalpa";
const DAY_MS = 24 * 60 * 60 * 1000;

// The expiry ladder, plus two nudges for a subscription that was paid for and
// never scheduled. Both sets share the (subscription, stage) claim ledger, so
// each one is delivered at most once.
type Stage = "2_day" | "1_day" | "expired" | "unscheduled_1" | "unscheduled_3";
type SubType = "food" | "cleaning";

interface PendingReminder {
  type: SubType;
  subscriptionId: string;
  userId: string;
  stage: Stage;
  planName: string;
  /**
   * YYYY-MM-DD. For the expiry ladder this is when the plan runs out; for the
   * unscheduled nudges it is the day the customer paid, which is what the
   * message is actually about.
   */
  expirationStr: string;
}

export interface ProcessStats {
  scanned: number;
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Sends "your subscription is about to expire" reminders for food meal-plan and
 * cleaning subscriptions. Runs daily (Vercel Cron). Each subscriber receives at
 * most one reminder per stage (2 days before, 1 day before, on expiry), enforced
 * by a UNIQUE(subscription_type, subscription_id, stage) ledger.
 */
@Injectable()
export class SubscriptionExpirationService {
  private readonly logger = new Logger(SubscriptionExpirationService.name);

  constructor(
    private readonly mail: MailService,
    private readonly notifications: AccountNotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ─── Public entry point ─────────────────────────────────────────────────────

  async processExpirationReminders(): Promise<ProcessStats> {
    const stats: ProcessStats = { scanned: 0, due: 0, sent: 0, skipped: 0, failed: 0 };
    const todayStr = this.businessDateStr(new Date());

    // Lifecycle sweep: flip any overdue subscriptions to "expired" before
    // sending reminders, so admin views + access checks stay correct.
    // Front-end reads also derive expired-vs-active from end_date on the fly,
    // so this sweep is defense-in-depth (keeps DB truth, not the only guard).
    await this.expireOverdueFoodSubscriptions(todayStr);
    await this.expireOverdueCleaningSubscriptions(todayStr);
    await this.expireOverdueBeachSubscriptions(todayStr);

    let pending: PendingReminder[] = [];
    try {
      pending = [
        ...(await this.collectFoodReminders(todayStr)),
        ...(await this.collectCleaningReminders(todayStr)),
        ...(await this.collectUnscheduledCleaningReminders(todayStr)),
      ];
    } catch (err) {
      this.logger.error(`Failed to collect subscriptions: ${(err as Error).message}`);
      return stats;
    }

    stats.scanned = pending.length;

    // Resolve recipient users in one batch.
    const userIds = Array.from(new Set(pending.map((p) => p.userId)));
    const users = await this.loadUsers(userIds);

    for (const item of pending) {
      stats.due++;
      const user = users.get(item.userId);
      if (!user?.email && !item.userId) {
        stats.skipped++;
        continue;
      }

      // Claim the (subscription, stage) slot atomically — duplicates are ignored,
      // so a second run on the same day sends nothing.
      const claimed = await this.claim(item);
      if (!claimed) {
        stats.skipped++;
        continue;
      }

      try {
        const methods = await this.deliver(item, user);
        await this.markMethods(item, methods);
        stats.sent++;
      } catch (err) {
        stats.failed++;
        this.logger.error(`Reminder ${item.type}:${item.subscriptionId}:${item.stage} failed: ${(err as Error).message}`);
        // Release the claim so it can retry on the next run.
        await this.releaseClaim(item);
      }
    }

    return stats;
  }

  // ─── Collectors ─────────────────────────────────────────────────────────────

  /** Mark food subscriptions whose end_date has passed as expired. */
  private async expireOverdueFoodSubscriptions(todayStr: string): Promise<void> {
    try {
      await this.supabaseRest(
        `/food_subscriptions?status=eq.active&end_date=lt.${todayStr}`,
        { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }) },
      );
    } catch (err) {
      this.logger.warn(`Food expiry sweep failed: ${(err as Error).message}`);
    }
  }

  /** Mark cleaning subscriptions whose service_end_date has passed as expired. */
  private async expireOverdueCleaningSubscriptions(todayStr: string): Promise<void> {
    try {
      const nowIso = new Date().toISOString();
      const expiredIds = new Set<string>();

      const byServiceEnd = await this.supabaseRest<any[]>(
        `/cleaning_subscriptions?subscription_status=eq.active&service_end_date=lt.${todayStr}&select=id`,
        { method: "PATCH", body: JSON.stringify({ subscription_status: "expired", is_active: false, updated_at: nowIso }) },
      );
      // Fall back to end_date for rows that never populated service_end_date.
      const byEnd = await this.supabaseRest<any[]>(
        `/cleaning_subscriptions?subscription_status=eq.active&service_end_date=is.null&end_date=lt.${todayStr}&select=id`,
        { method: "PATCH", body: JSON.stringify({ subscription_status: "expired", is_active: false, updated_at: nowIso }) },
      );
      for (const r of [...(byServiceEnd ?? []), ...(byEnd ?? [])]) if (r?.id) expiredIds.add(String(r.id));

      // A subscription's visits end with the period it paid for. Left alone, the
      // future ones stay `booked`, keep their Google Calendar events, and the
      // calendar sync re-creates any the admin deletes — so an expired plan
      // shows a phantom cleaning every week for ever. Cancel them here.
      await this.cancelFutureCleaningBookings([...expiredIds], todayStr);
    } catch (err) {
      this.logger.warn(`Cleaning expiry sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Cancel the future `booked` visits of subscriptions that just expired and
   * flag them for calendar sync, so their events are removed rather than left
   * as recurring phantoms. Past visits are history and are left untouched.
   * Best-effort throughout: one bad slot must not abort the sweep.
   */
  private async cancelFutureCleaningBookings(subIds: string[], todayStr: string): Promise<void> {
    if (subIds.length === 0) return;
    try {
      const inList = subIds.map((id) => `"${id}"`).join(",");
      const bookings = await this.supabaseRest<any[]>(
        `/cleaning_bookings?subscription_id=in.(${inList})&status=eq.booked&select=id,slot_id`,
      );
      if (!Array.isArray(bookings) || bookings.length === 0) return;

      // Resolve slot dates so only FUTURE visits are cancelled.
      const slotIds = [...new Set(bookings.map((b) => b.slot_id).filter(Boolean))].map((s) => `"${s}"`);
      const slots = slotIds.length
        ? await this.supabaseRest<any[]>(
            `/cleaning_available_slots?id=in.(${slotIds.join(",")})&select=id,date,current_bookings`,
          )
        : [];
      const slotById = new Map<string, any>((slots ?? []).map((s) => [String(s.id), s]));

      const future = bookings.filter((b) => {
        const d = slotById.get(String(b.slot_id))?.date;
        return d && String(d) >= todayStr;
      });
      if (future.length === 0) return;

      const ids = future.map((b) => `"${b.id}"`).join(",");
      await this.supabaseRest(
        `/cleaning_bookings?id=in.(${ids})`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "cancelled",
            google_calendar_sync_status: "pending",
            updated_at: new Date().toISOString(),
          }),
        },
      );

      // Free the slots the cancelled visits held.
      const perSlot = new Map<string, number>();
      for (const b of future) if (b.slot_id) perSlot.set(b.slot_id, (perSlot.get(b.slot_id) ?? 0) + 1);
      for (const [slotId, n] of perSlot) {
        const cur = Number(slotById.get(String(slotId))?.current_bookings) || 0;
        await this.supabaseRest(
          `/cleaning_available_slots?id=eq.${encodeURIComponent(slotId)}`,
          { method: "PATCH", body: JSON.stringify({ current_bookings: Math.max(0, cur - n), updated_at: new Date().toISOString() }) },
        ).catch(() => {/* best effort */});
      }
      this.logger.log(`Cancelled ${future.length} future cleaning visit(s) across ${subIds.length} expired subscription(s)`);
    } catch (err) {
      this.logger.warn(`Cancel future cleaning bookings failed: ${(err as Error).message}`);
    }
  }

  /**
   * Mark universal subscriptions whose end_date has passed as expired — beach
   * memberships AND rows on universal-only services (NULL source key). The
   * sweep used to be beach-only, so a universal purchase stayed `active` for
   * ever: it kept opening the booking engine (`plansHeldBy` checks status, not
   * end_date) and kept reading as live in every list. One-time offers made
   * this urgent — each one is a universal row with a real end. The
   * cleaning/food-keyed rows are the frozen backfill and stay untouched.
   */
  private async expireOverdueBeachSubscriptions(todayStr: string): Promise<void> {
    try {
      await this.supabaseRest(
        `/provider_subscriptions?or=(source_service_key.eq.beach,source_service_key.is.null)` +
          `&status=eq.active&end_date=lt.${todayStr}`,
        { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }) },
      );
    } catch (err) {
      this.logger.warn(`Universal expiry sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Note `cancel_at_period_end=eq.false` on both expiry collectors below.
   *
   * A customer who has cancelled is told the end date at the moment they
   * cancel; chasing them afterwards with "renew now to continue receiving
   * bookings" is nagging someone for a decision they already made. They still
   * keep access until the date — the flag changes nothing about that.
   */
  private async collectFoodReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/food_subscriptions?status=eq.active&cancel_at_period_end=eq.false&select=id,user_id,meal_plan_id,started_at,end_date,commitment_weeks&limit=500`,
    );
    if (!subs?.length) return [];

    const planNames = await this.lookupNames(
      "/food_meal_plans",
      subs.map((s) => s.meal_plan_id).filter(Boolean),
    );

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id) continue;
      // Prefer the authoritative end_date; fall back to started_at + weeks*7.
      let expirationStr: string | null = s.end_date ? String(s.end_date).slice(0, 10) : null;
      if (!expirationStr) {
        if (!s.started_at) continue;
        const weeks = s.commitment_weeks || 1;
        expirationStr = new Date(Date.parse(`${s.started_at}T00:00:00Z`) + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
      }
      const stage = this.stageFor(expirationStr, todayStr);
      if (!stage) continue;
      out.push({
        type: "food",
        subscriptionId: String(s.id),
        userId: s.user_id,
        stage,
        planName: planNames.get(s.meal_plan_id) || "your meal plan",
        expirationStr,
      });
    }
    return out;
  }

  private async collectCleaningReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/cleaning_subscriptions?subscription_status=eq.active&is_active=eq.true&cancel_at_period_end=eq.false&select=id,user_id,package_id,service_end_date,end_date,paid_until&limit=500`,
    );
    if (!subs?.length) return [];

    const planNames = await this.lookupNames(
      "/cleaning_packages",
      subs.map((s) => s.package_id).filter(Boolean),
    );

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id) continue;
      const expirationStr: string | null = s.service_end_date || s.end_date || s.paid_until || null;
      if (!expirationStr) continue;
      const stage = this.stageFor(expirationStr, todayStr);
      if (!stage) continue;
      out.push({
        type: "cleaning",
        subscriptionId: String(s.id),
        userId: s.user_id,
        stage,
        planName: planNames.get(s.package_id) || "your cleaning plan",
        expirationStr,
      });
    }
    return out;
  }

  /**
   * Paid for, never scheduled.
   *
   * A cleaning subscription lands on `pending_schedule` the moment payment
   * clears; the customer is meant to pick a day and time on the next screen.
   * If they close the tab there, nothing has ever chased them — the expiry
   * ladder only looks at `status = active`, so these fall between the two.
   * Three were sitting unscheduled for 5, 9 and 12 days when this was written.
   *
   * Only subscriptions with no booking at all. One visit already on the
   * calendar means they found the screen.
   */
  private async collectUnscheduledCleaningReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/cleaning_subscriptions?payment_status=eq.paid&subscription_status=eq.pending_schedule` +
        `&deleted_at=is.null&select=id,user_id,package_id,created_at&limit=500`,
    );
    if (!subs?.length) return [];

    // One query for every booking that belongs to this batch, rather than one
    // per subscription.
    const ids = subs.map((s) => s.id).filter(Boolean);
    const booked = new Set<string>();
    if (ids.length) {
      const rows = await this.supabaseRest<any[]>(
        `/cleaning_bookings?subscription_id=in.(${ids.map((id) => `"${id}"`).join(",")})&select=subscription_id`,
      );
      (rows ?? []).forEach((b) => b?.subscription_id && booked.add(String(b.subscription_id)));
    }

    const planNames = await this.lookupNames(
      "/cleaning_packages",
      subs.map((s) => s.package_id).filter(Boolean),
    );

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id || !s.created_at) continue;
      if (booked.has(String(s.id))) continue;

      const paidOn = String(s.created_at).slice(0, 10);
      const daysSince = Math.round(
        (Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${paidOn}T00:00:00Z`)) / DAY_MS,
      );

      // Day 1 and day 3. Not day 0 — the checkout screen just asked them, and
      // an email in the same minute reads as a system that isn't paying
      // attention. Anything older than day 3 has had both nudges; the claim
      // ledger stops a repeat, and `>=` lets a subscription that was created
      // while the cron was down still get its first one.
      let stage: Stage | null = null;
      if (daysSince === 1) stage = "unscheduled_1";
      else if (daysSince >= 3) stage = "unscheduled_3";
      if (!stage) continue;

      out.push({
        type: "cleaning",
        subscriptionId: String(s.id),
        userId: s.user_id,
        stage,
        planName: planNames.get(s.package_id) || "your cleaning plan",
        expirationStr: paidOn,
      });
    }
    return out;
  }

  /** 2 → "2_day", 1 → "1_day", 0 → "expired"; anything else → not due today. */
  private stageFor(expirationStr: string, todayStr: string): Stage | null {
    const daysRemaining = Math.round(
      (Date.parse(`${expirationStr}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / DAY_MS,
    );
    if (daysRemaining === 2) return "2_day";
    if (daysRemaining === 1) return "1_day";
    if (daysRemaining === 0) return "expired";
    return null;
  }

  // ─── Delivery ────────────────────────────────────────────────────────────────

  private async deliver(
    item: PendingReminder,
    user?: { email?: string; name?: string; display_name?: string },
  ): Promise<string[]> {
    const content = this.buildContent(item);
    const methods: string[] = [];

    // In-app notification center
    await this.notifications.create({
      recipientUserId: item.userId,
      category: "subscription",
      type: content.notificationType,
      title: content.title,
      body: content.body,
      relatedEntityType: item.type === "food" ? "food_subscription" : "cleaning_subscription",
      relatedEntityId: item.subscriptionId,
      // The unscheduled nudge lands on the schedule picker for THAT
      // subscription. Sending it to the subscriptions list would ask the
      // customer to find the thing the message is about.
      actionUrl: item.stage.startsWith("unscheduled")
        ? `/services/cleaning/book?subscriptionId=${item.subscriptionId}`
        : "/my-subscriptions",
      metadata: { stage: item.stage, planName: item.planName, expirationDate: item.expirationStr },
    });
    methods.push("in_app");

    // Email
    if (user?.email) {
      await this.mail.sendMail({
        to: user.email,
        subject: content.subject,
        html: this.emailHtml(item, content, user),
        text: content.text,
      });
      methods.push("email");
    }

    return methods;
  }

  private buildContent(item: PendingReminder): {
    notificationType: NotificationType;
    subject: string;
    title: string;
    body: string;
    text: string;
  } {
    const plan = item.planName;
    const date = this.formatDate(item.expirationStr);

    // Paid, never scheduled. Note the tone: this customer has done nothing
    // wrong and is owed a service they have already paid for, so the message
    // is a reminder that something is waiting for them, not a demand.
    if (item.stage === "unscheduled_1" || item.stage === "unscheduled_3") {
      const waited = item.stage === "unscheduled_3" ? " It has been a few days." : "";
      return {
        notificationType: "reminder_general",
        subject: "Pick a time for your cleaning",
        title: "Your cleaning is paid for — choose a time",
        body:
          `You paid for ${plan} on ${date} and haven't picked a day and time yet.${waited} ` +
          `Choose a slot and we'll put it on the schedule. Nothing expires in the meantime.`,
        text:
          `You paid for ${plan} on ${date} and haven't picked a day and time yet.${waited}\n\n` +
          `Choose a slot and we'll put it on the schedule. Nothing expires in the meantime.`,
      };
    }

    if (item.stage === "2_day") {
      return {
        notificationType: "subscription_expiring_soon",
        subject: "Your subscription is about to expire",
        title: "Your subscription expires in 2 days",
        body:
          `Your current subscription plan ${plan} will expire on ${date}. ` +
          `Renew your subscription now to continue receiving bookings and avoid interruptions to your account. ` +
          `If your subscription expires, new bookings may no longer be available.`,
        text:
          `Your current subscription plan ${plan} will expire on ${date}.\n\n` +
          `Renew your subscription now to continue receiving bookings and avoid interruptions to your account.\n\n` +
          `If your subscription expires, new bookings may no longer be available.`,
      };
    }

    if (item.stage === "1_day") {
      return {
        notificationType: "subscription_expiring_tomorrow",
        subject: "Renew your subscription to keep receiving bookings",
        title: "Your subscription expires tomorrow",
        body:
          `Your current subscription plan ${plan} expires tomorrow (${date}). ` +
          `Renew your subscription today to continue receiving bookings and keep your account active. ` +
          `Don’t risk losing potential customers and new orders.`,
        text:
          `Your current subscription plan ${plan} expires tomorrow (${date}).\n\n` +
          `Renew your subscription today to continue receiving bookings and keep your account active.\n\n` +
          `Don’t risk losing potential customers and new orders.`,
      };
    }

    return {
      notificationType: "subscription_expired",
      subject: "Your subscription has expired — renew to continue",
      title: "Your subscription has expired",
      body:
        `Your subscription plan ${plan} has expired. ` +
        `Renew now to continue receiving bookings and reactivate your plan immediately.`,
      text:
        `Your subscription plan ${plan} has expired.\n\n` +
        `Renew now to continue receiving bookings and reactivate your plan immediately.`,
    };
  }

  private emailHtml(
    item: PendingReminder,
    content: { title: string; body: string },
    user?: { name?: string; display_name?: string },
  ): string {
    const name = user?.display_name || user?.name || "there";
    // "Renew Subscription" is the wrong button on a subscription that has not
    // started yet — it is paid for and waiting for a time.
    const unscheduled = item.stage.startsWith("unscheduled");
    const ctaUrl = unscheduled
      ? `${this.appUrl()}/services/cleaning/book?subscriptionId=${encodeURIComponent(item.subscriptionId)}`
      : `${this.appUrl()}/my-subscriptions`;
    const ctaLabel = unscheduled ? "Choose a time" : "Renew Subscription";
    return `
      <div style="font-family:Inter,Arial,sans-serif;color:#1f1f1f;line-height:1.6;max-width:560px;">
        <h2 style="margin:0 0 8px;font-size:22px;">${this.htmlEscape(content.title)}</h2>
        <p style="margin:0 0 16px;color:#6b7280;">Hi ${this.htmlEscape(name)},</p>
        <p style="margin:0 0 24px;">${this.htmlEscape(content.body)}</p>
        <a href="${ctaUrl}"
           style="display:inline-block;background:#F8A31A;color:#1f1f1f;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:9999px;">
          ${ctaLabel}
        </a>
        <p style="margin:28px 0 0;font-size:13px;color:#9ca3af;">— ${APP_BRAND_NAME}</p>
      </div>`;
  }

  // ─── De-duplication ledger ────────────────────────────────────────────────────

  /** Returns true when this run claimed the slot (i.e. it had not been sent before). */
  private async claim(item: PendingReminder): Promise<boolean> {
    try {
      const rows = await this.supabaseRest<any[]>(
        `/subscription_expiration_notifications?on_conflict=subscription_type,subscription_id,stage`,
        {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify({
            subscription_type: item.type,
            subscription_id: item.subscriptionId,
            stage: item.stage,
            user_id: item.userId,
            expiration_date: item.expirationStr,
          }),
        },
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      this.logger.warn(`claim failed for ${item.type}:${item.subscriptionId}:${item.stage}: ${(err as Error).message}`);
      return false;
    }
  }

  private async markMethods(item: PendingReminder, methods: string[]): Promise<void> {
    try {
      await this.supabaseRest(
        `/subscription_expiration_notifications?subscription_type=eq.${item.type}&subscription_id=eq.${encodeURIComponent(item.subscriptionId)}&stage=eq.${item.stage}`,
        { method: "PATCH", body: JSON.stringify({ methods_sent: methods }) },
      );
    } catch { /* best effort */ }
  }

  private async releaseClaim(item: PendingReminder): Promise<void> {
    try {
      await this.supabaseRest(
        `/subscription_expiration_notifications?subscription_type=eq.${item.type}&subscription_id=eq.${encodeURIComponent(item.subscriptionId)}&stage=eq.${item.stage}`,
        { method: "DELETE" },
      );
    } catch { /* best effort */ }
  }

  // ─── Lookups & helpers ─────────────────────────────────────────────────────────

  private async lookupNames(table: string, ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = Array.from(new Set(ids));
    if (!unique.length) return map;
    try {
      const rows = await this.supabaseRest<any[]>(
        `${table}?id=in.(${unique.map((id) => `"${id}"`).join(",")})&select=id,name`,
      );
      for (const r of rows ?? []) map.set(String(r.id), r.name);
    } catch (err) {
      this.logger.warn(`Name lookup on ${table} failed: ${(err as Error).message}`);
    }
    return map;
  }

  private async loadUsers(
    ids: string[],
  ): Promise<Map<string, { email?: string; name?: string; display_name?: string }>> {
    const map = new Map<string, { email?: string; name?: string; display_name?: string }>();
    if (!ids.length) return map;
    try {
      const rows = await this.supabaseRest<any[]>(
        `/users?id=in.(${ids.map((id) => `"${id}"`).join(",")})&select=id,email,name,display_name`,
      );
      for (const r of rows ?? []) map.set(String(r.id), { email: r.email, name: r.name, display_name: r.display_name });
    } catch (err) {
      this.logger.warn(`User lookup failed: ${(err as Error).message}`);
    }
    return map;
  }

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") || this.config.get<string>("SUPABASE_ANON_KEY");
    if (!baseUrl || !key) throw new Error("Supabase REST not configured");
    return fetch(`${baseUrl}/rest/v1${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  private appUrl(): string {
    return publicAppUrl(this.config.get<string>("FRONTEND_URL"));
  }

  private businessDateStr(d: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  }

  private formatDate(dateStr: string): string {
    try {
      return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
        timeZone: BUSINESS_TZ, month: "long", day: "numeric", year: "numeric",
      });
    } catch {
      return dateStr;
    }
  }

  private htmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
