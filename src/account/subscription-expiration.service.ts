import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "../mail/mail.service";
import { AccountNotificationsService, NotificationType } from "./account-notifications.service";
import { publicAppUrl } from "../config/app-origins";

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/Tegucigalpa";
const DAY_MS = 24 * 60 * 60 * 1000;

type Stage = "2_day" | "1_day" | "expired";
type SubType = "food" | "cleaning";

interface PendingReminder {
  type: SubType;
  subscriptionId: string;
  userId: string;
  stage: Stage;
  planName: string;
  expirationStr: string; // YYYY-MM-DD
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
      await this.supabaseRest(
        `/cleaning_subscriptions?subscription_status=eq.active&service_end_date=lt.${todayStr}`,
        { method: "PATCH", body: JSON.stringify({ subscription_status: "expired", is_active: false, updated_at: new Date().toISOString() }) },
      );
      // Fall back to end_date for rows that never populated service_end_date.
      await this.supabaseRest(
        `/cleaning_subscriptions?subscription_status=eq.active&service_end_date=is.null&end_date=lt.${todayStr}`,
        { method: "PATCH", body: JSON.stringify({ subscription_status: "expired", is_active: false, updated_at: new Date().toISOString() }) },
      );
    } catch (err) {
      this.logger.warn(`Cleaning expiry sweep failed: ${(err as Error).message}`);
    }
  }

  /** Mark beach-club subscriptions whose end_date has passed as expired. */
  private async expireOverdueBeachSubscriptions(todayStr: string): Promise<void> {
    try {
      await this.supabaseRest(
        `/beach_club_subscriptions?status=eq.active&end_date=lt.${todayStr}`,
        { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }) },
      );
    } catch (err) {
      this.logger.warn(`Beach expiry sweep failed: ${(err as Error).message}`);
    }
  }

  private async collectFoodReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/food_subscriptions?status=eq.active&select=id,user_id,meal_plan_id,started_at,end_date,commitment_weeks&limit=500`,
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
      `/cleaning_subscriptions?subscription_status=eq.active&is_active=eq.true&select=id,user_id,package_id,service_end_date,end_date,paid_until&limit=500`,
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
      actionUrl: "/my-subscriptions",
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
    const renewUrl = `${this.appUrl()}/my-subscriptions`;
    return `
      <div style="font-family:Inter,Arial,sans-serif;color:#1f1f1f;line-height:1.6;max-width:560px;">
        <h2 style="margin:0 0 8px;font-size:22px;">${this.htmlEscape(content.title)}</h2>
        <p style="margin:0 0 16px;color:#6b7280;">Hi ${this.htmlEscape(name)},</p>
        <p style="margin:0 0 24px;">${this.htmlEscape(content.body)}</p>
        <a href="${renewUrl}"
           style="display:inline-block;background:#F8A31A;color:#1f1f1f;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:9999px;">
          Renew Subscription
        </a>
        <p style="margin:28px 0 0;font-size:13px;color:#9ca3af;">— ProsperaSub</p>
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
