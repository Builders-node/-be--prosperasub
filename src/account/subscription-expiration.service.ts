import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { MailService } from "../mail/mail.service";
import { AccountNotificationsService, NotificationType } from "./account-notifications.service";
import { publicAppUrl } from "../config/app-origins";
import { APP_BRAND_NAME } from "../config/branding";

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/Tegucigalpa";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The win-back offer: a personal code, this much off, for this long. */
export const WINBACK_PERCENT_OFF = 15;
export const WINBACK_CODE_DAYS = 14;

/**
 * The ladder, per subscription PERIOD:
 *   2_day · 1_day · expired   — before and on the last day: renew in one tap
 *   winback_7                 — a week after it ended, nothing since: come back
 *   winback_21                — three weeks: come back, with a personal code
 * plus two nudges for a cleaning that was paid for and never scheduled.
 *
 * The ledger key includes the period end. It used to be (type, subscription,
 * stage) alone — and a renewal extends the SAME row, so after a customer's
 * first renewal no reminder was ever sent to them again. The customers who had
 * renewed before were exactly the ones who then lapsed without a word.
 */
type Stage = "2_day" | "1_day" | "expired" | "winback_7" | "winback_21" | "unscheduled_1" | "unscheduled_3";
type SubType = "food" | "cleaning" | "beach" | "plan";

interface PlanInfo { name: string; active: boolean; oneTime: boolean }

interface PendingReminder {
  type: SubType;
  subscriptionId: string;
  userId: string;
  stage: Stage;
  planName: string;
  /** The id the checkout link carries (legacy or universal — it takes both). */
  planId: string | null;
  /** False when the plan is no longer sold: the link goes to Discovery instead. */
  planAvailable: boolean;
  /** Unscheduled nudges only: the business owner, told alongside the customer. */
  providerOwnerId?: string | null;
  providerUniversalId?: string | null;
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

/** One tap "why", on the expired and win-back messages. Keys match churn_feedback.reason. */
export const LEAVE_REASONS: Array<{ key: string; label: string }> = [
  { key: "moved", label: "I left the island" },
  { key: "price", label: "Too expensive" },
  { key: "quality", label: "Wasn't happy with it" },
  { key: "forgot", label: "Forgot to renew" },
];

/**
 * Renewal reminders and win-backs for every subscription a customer can renew:
 * food, cleaning, beach memberships and universal plans. Runs daily (Vercel
 * Cron). One message per (subscription, stage, period) — the ledger enforces it.
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
    await this.expireOverdueFoodSubscriptions(todayStr);
    await this.expireOverdueCleaningSubscriptions(todayStr);
    await this.expireOverdueBeachSubscriptions(todayStr);

    let pending: PendingReminder[] = [];
    try {
      pending = [
        ...(await this.collectFoodReminders(todayStr)),
        ...(await this.collectCleaningReminders(todayStr)),
        ...(await this.collectUniversalReminders(todayStr)),
        ...(await this.collectWinbacks(todayStr)),
        ...(await this.collectUnscheduledCleaningReminders(todayStr)),
      ];
    } catch (err) {
      this.logger.error(`Failed to collect subscriptions: ${(err as Error).message}`);
      return stats;
    }

    stats.scanned = pending.length;
    const userIds = Array.from(new Set(pending.map((p) => p.userId)));
    const users = await this.loadUsers(userIds);

    for (const item of pending) {
      stats.due++;
      const user = users.get(item.userId);
      if (!user?.email && !item.userId) {
        stats.skipped++;
        continue;
      }

      // Claim the (subscription, stage, period) slot atomically — duplicates
      // are ignored, so a second run on the same day sends nothing.
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
   * The renewal ladder skips two kinds of subscription:
   *
   *  - `cancel_at_period_end`: the customer was told the end date when they
   *    cancelled; chasing them with "renew now" nags a decision already made.
   *  - `auto_renew`: PayPal renews it by itself — "renew now" would sell them
   *    a second period.
   */
  private async collectFoodReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/food_subscriptions?status=eq.active&cancel_at_period_end=eq.false&auto_renew=not.is.true` +
        `&select=id,user_id,meal_plan_id,started_at,end_date,commitment_weeks&limit=500`,
    );
    if (!subs?.length) return [];
    const names = await this.lookupNames("/food_meal_plans", subs.map((s) => s.meal_plan_id).filter(Boolean));

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id) continue;
      const expirationStr = this.foodEnd(s);
      if (!expirationStr) continue;
      const stage = this.ladderStage(expirationStr, todayStr);
      if (!stage) continue;
      out.push({
        type: "food",
        subscriptionId: String(s.id),
        userId: s.user_id,
        stage,
        planName: names.get(s.meal_plan_id) || "your meal plan",
        planId: s.meal_plan_id ? String(s.meal_plan_id) : null,
        planAvailable: true,
        expirationStr,
      });
    }
    return out;
  }

  private async collectCleaningReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/cleaning_subscriptions?subscription_status=eq.active&is_active=eq.true&cancel_at_period_end=eq.false&auto_renew=not.is.true` +
        `&select=id,user_id,package_id,service_end_date,end_date,paid_until&limit=500`,
    );
    if (!subs?.length) return [];
    const names = await this.lookupNames("/cleaning_packages", subs.map((s) => s.package_id).filter(Boolean));

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id) continue;
      const expirationStr = this.cleaningEnd(s);
      if (!expirationStr) continue;
      const stage = this.ladderStage(expirationStr, todayStr);
      if (!stage) continue;
      out.push({
        type: "cleaning",
        subscriptionId: String(s.id),
        userId: s.user_id,
        stage,
        planName: names.get(s.package_id) || "your cleaning plan",
        planId: s.package_id ? String(s.package_id) : null,
        planAvailable: true,
        expirationStr,
      });
    }
    return out;
  }

  /**
   * Beach memberships and universal plans — they had no reminders at all. The
   * frozen cleaning/food backfill rows are excluded, like everywhere else, and
   * a one-time purchase has nothing to renew.
   */
  private async collectUniversalReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/provider_subscriptions?or=(source_service_key.eq.beach,source_service_key.is.null)` +
        `&status=eq.active&cancel_at_period_end=eq.false&auto_renew=not.is.true` +
        `&select=id,user_id,plan_id,end_date,source_service_key&limit=500`,
    );
    if (!subs?.length) return [];
    const plans = await this.lookupPlans(subs.map((s) => s.plan_id), false);

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id || !s.end_date) continue;
      const plan = plans.get(String(s.plan_id));
      if (plan?.oneTime) continue;
      const expirationStr = String(s.end_date).slice(0, 10);
      const stage = this.ladderStage(expirationStr, todayStr);
      if (!stage) continue;
      out.push({
        type: s.source_service_key === "beach" ? "beach" : "plan",
        subscriptionId: String(s.id),
        userId: String(s.user_id),
        stage,
        planName: plan?.name || "your membership",
        planId: s.plan_id ? String(s.plan_id) : null,
        planAvailable: true,
        expirationStr,
      });
    }
    return out;
  }

  /**
   * Seven and twenty-one days after a subscription ended, if the customer has
   * not come back to that service since. One message per customer per day per
   * stage, however many old subscriptions ended that day.
   */
  private async collectWinbacks(todayStr: string): Promise<PendingReminder[]> {
    const d7 = this.shiftDate(todayStr, -7);
    const d21 = this.shiftDate(todayStr, -21);
    const days = `(${d7},${d21})`;
    const out: PendingReminder[] = [];
    const stageOf = (end: string): Stage => (end === d7 ? "winback_7" : "winback_21");

    // Food
    try {
      const subs = await this.supabaseRest<any[]>(
        `/food_subscriptions?status=in.(expired,cancelled)&end_date=in.${days}&select=id,user_id,meal_plan_id,end_date&limit=500`,
      );
      if (subs?.length) {
        const live = await this.usersWithLive("/food_subscriptions", "status", subs.map((s) => s.user_id));
        const plans = await this.lookupPlans(subs.map((s) => s.meal_plan_id), true);
        const names = await this.lookupNames("/food_meal_plans", subs.map((s) => s.meal_plan_id).filter(Boolean));
        for (const s of subs) {
          if (!s.user_id || live.has(String(s.user_id))) continue;
          const expirationStr = String(s.end_date).slice(0, 10);
          const plan = plans.get(String(s.meal_plan_id));
          out.push({
            type: "food", subscriptionId: String(s.id), userId: String(s.user_id),
            stage: stageOf(expirationStr),
            planName: names.get(s.meal_plan_id) || plan?.name || "your meal plan",
            planId: s.meal_plan_id ? String(s.meal_plan_id) : null,
            planAvailable: plan ? plan.active : false,
            expirationStr,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Food win-backs skipped: ${(err as Error).message}`);
    }

    // Cleaning — the end lives in one of three columns.
    try {
      const subs = await this.supabaseRest<any[]>(
        `/cleaning_subscriptions?subscription_status=in.(expired,cancelled)` +
          `&or=(service_end_date.in.${days},end_date.in.${days},paid_until.in.${days})` +
          `&select=id,user_id,package_id,service_end_date,end_date,paid_until&limit=500`,
      );
      if (subs?.length) {
        const live = await this.usersWithLive("/cleaning_subscriptions", "subscription_status", subs.map((s) => s.user_id));
        const plans = await this.lookupPlans(subs.map((s) => s.package_id), true);
        const names = await this.lookupNames("/cleaning_packages", subs.map((s) => s.package_id).filter(Boolean));
        for (const s of subs) {
          if (!s.user_id || live.has(String(s.user_id))) continue;
          const expirationStr = this.cleaningEnd(s);
          if (expirationStr !== d7 && expirationStr !== d21) continue;
          const plan = plans.get(String(s.package_id));
          out.push({
            type: "cleaning", subscriptionId: String(s.id), userId: String(s.user_id),
            stage: stageOf(expirationStr),
            planName: names.get(s.package_id) || plan?.name || "your cleaning plan",
            planId: s.package_id ? String(s.package_id) : null,
            planAvailable: plan ? plan.active : false,
            expirationStr,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Cleaning win-backs skipped: ${(err as Error).message}`);
    }

    // Beach + universal
    try {
      const subs = await this.supabaseRest<any[]>(
        `/provider_subscriptions?or=(source_service_key.eq.beach,source_service_key.is.null)` +
          `&status=in.(expired,cancelled)&end_date=in.${days}&select=id,user_id,plan_id,end_date,source_service_key&limit=500`,
      );
      if (subs?.length) {
        const live = await this.usersWithLive("/provider_subscriptions", "status", subs.map((s) => s.user_id));
        const plans = await this.lookupPlans(subs.map((s) => s.plan_id), false);
        for (const s of subs) {
          if (!s.user_id || live.has(String(s.user_id))) continue;
          const plan = plans.get(String(s.plan_id));
          if (plan?.oneTime) continue;
          const expirationStr = String(s.end_date).slice(0, 10);
          out.push({
            type: s.source_service_key === "beach" ? "beach" : "plan",
            subscriptionId: String(s.id), userId: String(s.user_id),
            stage: stageOf(expirationStr),
            planName: plan?.name || "your membership",
            planId: s.plan_id ? String(s.plan_id) : null,
            planAvailable: plan ? plan.active : false,
            expirationStr,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`Universal win-backs skipped: ${(err as Error).message}`);
    }

    // One per customer per stage per day — several old plans ending on the
    // same day must not become several "we miss you" emails.
    const seen = new Set<string>();
    return out.filter((r) => {
      const k = `${r.userId}|${r.stage}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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
   *
   * `active` with no visits is the same situation under another status — paid,
   * period running, schedule empty — and it was invisible to both this nudge
   * and the business. Only recent ones (14 days), so old subscriptions run
   * outside the booking calendar are not woken up.
   */
  private async collectUnscheduledCleaningReminders(todayStr: string): Promise<PendingReminder[]> {
    const subs = await this.supabaseRest<any[]>(
      `/cleaning_subscriptions?payment_status=eq.paid&subscription_status=in.(pending_schedule,active)` +
        `&deleted_at=is.null&created_at=gte.${this.shiftDate(todayStr, -14)}` +
        `&select=id,user_id,package_id,provider_id,created_at&limit=500`,
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
    const owners = await this.cleaningOwners(subs.map((s) => s.provider_id));

    const out: PendingReminder[] = [];
    for (const s of subs) {
      if (!s.user_id || !s.created_at) continue;
      if (booked.has(String(s.id))) continue;
      const owner = owners.get(String(s.provider_id));

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
        planId: s.package_id ? String(s.package_id) : null,
        planAvailable: true,
        providerOwnerId: owner?.ownerId ?? null,
        providerUniversalId: owner?.id ?? null,
        expirationStr: paidOn,
      });
    }
    return out;
  }

  /** 2 → "2_day", 1 → "1_day", 0 → "expired"; anything else → not due today. */
  private ladderStage(expirationStr: string, todayStr: string): Stage | null {
    const daysRemaining = Math.round(
      (Date.parse(`${expirationStr}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / DAY_MS,
    );
    if (daysRemaining === 2) return "2_day";
    if (daysRemaining === 1) return "1_day";
    if (daysRemaining === 0) return "expired";
    return null;
  }

  private foodEnd(s: any): string | null {
    if (s.end_date) return String(s.end_date).slice(0, 10);
    if (!s.started_at) return null;
    const weeks = s.commitment_weeks || 1;
    return new Date(Date.parse(`${s.started_at}T00:00:00Z`) + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
  }

  private cleaningEnd(s: any): string | null {
    const v = s.service_end_date || s.end_date || s.paid_until || null;
    return v ? String(v).slice(0, 10) : null;
  }

  private shiftDate(dateStr: string, days: number): string {
    return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  }

  // ─── Where each message sends the customer ─────────────────────────────────

  /**
   * The button goes straight to paying for THIS plan again — not to the
   * subscriptions list, which made the customer find the plan, find Renew and
   * only then see a payment screen.
   *
   *  - before/at the end: the renewal checkout, which extends the same row;
   *  - after it ended: a fresh checkout of the same plan (with the personal
   *    code on day 21). A plan no longer sold sends them to Discovery.
   */
  private actionPath(item: PendingReminder, promoCode?: string | null): string {
    if (item.stage.startsWith("unscheduled")) {
      return `/services/cleaning/book?subscriptionId=${encodeURIComponent(item.subscriptionId)}`;
    }
    if (!item.planId) return "/my-subscriptions";
    const plan = encodeURIComponent(item.planId);
    if (item.stage === "winback_7" || item.stage === "winback_21") {
      if (!item.planAvailable) return promoCode ? `/discovery?promo=${encodeURIComponent(promoCode)}` : "/discovery";
      return promoCode ? `/checkout/${plan}?promo=${encodeURIComponent(promoCode)}` : `/checkout/${plan}`;
    }
    return `/checkout/${plan}?renew=${encodeURIComponent(item.subscriptionId)}`;
  }

  private leavePath(item: PendingReminder, reason: string): string {
    return `/feedback/leaving?service=${item.type}&sub=${encodeURIComponent(item.subscriptionId)}&reason=${reason}`;
  }

  private asksWhy(item: PendingReminder): boolean {
    return item.stage === "expired" || item.stage === "winback_7" || item.stage === "winback_21";
  }

  // ─── Delivery ────────────────────────────────────────────────────────────────

  private async deliver(
    item: PendingReminder,
    user?: { email?: string; name?: string; display_name?: string },
  ): Promise<string[]> {
    const promo = item.stage === "winback_21" ? await this.createWinbackCode(item) : null;
    const content = this.buildContent(item, promo);
    const path = this.actionPath(item, promo?.code);
    const methods: string[] = [];

    await this.notifications.create({
      recipientUserId: item.userId,
      category: "subscription",
      type: content.notificationType,
      title: content.title,
      body: content.body,
      relatedEntityType: this.entityType(item.type),
      relatedEntityId: item.subscriptionId,
      actionUrl: path,
      metadata: { stage: item.stage, planName: item.planName, expirationDate: item.expirationStr, promoCode: promo?.code ?? null },
    });
    methods.push("in_app");

    // The business hears it too: a paid customer with nothing on the schedule
    // is theirs to fix, and until now neither side was told.
    if (item.stage.startsWith("unscheduled") && item.providerOwnerId) {
      try {
        await this.notifications.create({
          recipientUserId: item.providerOwnerId,
          category: "booking",
          type: "reminder_general",
          title: "A paid customer has no visit scheduled",
          body: `${user?.display_name || user?.name || "A customer"} paid for ${item.planName} on ` +
            `${this.formatDate(item.expirationStr)} and nothing is on the schedule yet.`,
          relatedEntityType: "cleaning_subscription",
          relatedEntityId: item.subscriptionId,
          actionUrl: item.providerUniversalId
            ? `/my-provider/${item.providerUniversalId}?tab=bookings&view=customer`
            : "/my-business",
          metadata: { stage: item.stage },
        });
        methods.push("provider_in_app");
      } catch (err) {
        this.logger.warn(`Owner notice for ${item.subscriptionId} failed: ${(err as Error).message}`);
      }
    }

    if (user?.email) {
      await this.mail.sendMail({
        to: user.email,
        subject: content.subject,
        html: this.emailHtml(item, content, user, path),
        text: `${content.body}\n\n${content.ctaLabel}: ${this.appUrl()}${path}`,
      });
      methods.push("email");
    }

    return methods;
  }

  private entityType(type: SubType): string {
    return type === "food" ? "food_subscription"
      : type === "cleaning" ? "cleaning_subscription"
      : "provider_subscription";
  }

  /**
   * A code for this customer alone: one use, WINBACK_PERCENT_OFF off, valid
   * WINBACK_CODE_DAYS. If it cannot be made the message still goes, without
   * the offer — the day-21 slot does not come round again.
   */
  private async createWinbackCode(item: PendingReminder): Promise<{ code: string; endsAt: string } | null> {
    const code = `BACK${randomBytes(4).toString("hex").toUpperCase().slice(0, 6)}`;
    const now = new Date();
    const endsAt = new Date(now.getTime() + WINBACK_CODE_DAYS * DAY_MS);
    try {
      await this.supabaseRest(`/promo_codes`, {
        method: "POST",
        body: JSON.stringify({
          code,
          description: `Win-back · ${item.type}:${item.subscriptionId} · user ${item.userId}`,
          kind: "percent",
          percent_off: WINBACK_PERCENT_OFF,
          max_redemptions: 1,
          per_customer_limit: 1,
          starts_at: now.toISOString(),
          ends_at: endsAt.toISOString(),
          status: "active",
        }),
      });
      return { code, endsAt: this.businessDateStr(endsAt) };
    } catch (err) {
      this.logger.warn(`Win-back code for ${item.userId} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private buildContent(item: PendingReminder, promo: { code: string; endsAt: string } | null): {
    notificationType: NotificationType;
    subject: string;
    title: string;
    body: string;
    ctaLabel: string;
  } {
    const plan = item.planName;
    const date = this.formatDate(item.expirationStr);

    // Paid, never scheduled. This customer is owed a service already paid for,
    // so the message is a reminder that something is waiting, not a demand.
    if (item.stage === "unscheduled_1" || item.stage === "unscheduled_3") {
      const waited = item.stage === "unscheduled_3" ? " It has been a few days." : "";
      return {
        notificationType: "reminder_general",
        subject: "Pick a time for your cleaning",
        title: "Your cleaning is paid for — choose a time",
        body: `You paid for ${plan} on ${date} and haven't picked a day and time yet.${waited} ` +
          `Choose a slot and we'll put it on the schedule. Nothing expires in the meantime.`,
        ctaLabel: "Choose a time",
      };
    }

    // Written to a customer. The old copy ("keep receiving bookings… don't
    // risk losing potential customers") read as if addressed to a business.
    if (item.stage === "2_day") {
      return {
        notificationType: "subscription_expiring_soon",
        subject: `Your ${plan} ends on ${date}`,
        title: `${plan} ends in 2 days`,
        body: `Your ${plan} runs until ${date}. Renew now and it carries on without a gap — ` +
          `the new period starts the day after this one ends.`,
        ctaLabel: "Renew",
      };
    }
    if (item.stage === "1_day") {
      return {
        notificationType: "subscription_expiring_tomorrow",
        subject: `Your ${plan} ends tomorrow`,
        title: `${plan} ends tomorrow`,
        body: `Your ${plan} ends tomorrow, ${date}. Renew today and nothing stops.`,
        ctaLabel: "Renew",
      };
    }
    if (item.stage === "expired") {
      return {
        notificationType: "subscription_expired",
        subject: `Your ${plan} has ended`,
        title: `${plan} has ended`,
        body: `Your ${plan} ended on ${date}. You can pick it up again in a minute — the same plan, the same details.`,
        ctaLabel: "Renew",
      };
    }
    if (item.stage === "winback_7") {
      return {
        notificationType: "reminder_general",
        subject: `Want your ${plan} back?`,
        title: `Want your ${plan} back?`,
        body: item.planAvailable
          ? `It's been a week since your ${plan} ended. If you'd like it again, it's one tap — the same plan, the same details.`
          : `It's been a week since your ${plan} ended. That plan isn't offered any more, but there's plenty more on ${APP_BRAND_NAME}.`,
        ctaLabel: item.planAvailable ? "Order again" : "See what's on",
      };
    }
    // winback_21
    const until = promo ? this.formatDate(promo.endsAt) : "";
    return {
      notificationType: "reminder_general",
      subject: promo ? `${WINBACK_PERCENT_OFF}% off if you come back` : `We'd love to have you back`,
      title: promo ? `${WINBACK_PERCENT_OFF}% off your next order` : `We'd love to have you back`,
      body: promo
        ? `Your ${plan} ended three weeks ago. Here's ${WINBACK_PERCENT_OFF}% off your next order with the code ` +
          `${promo.code} — it's yours alone and works until ${until}.`
        : `Your ${plan} ended three weeks ago. Whenever you're ready, it's one tap to start again.`,
      ctaLabel: item.planAvailable ? (promo ? `Use ${promo.code}` : "Order again") : "See what's on",
    };
  }

  private emailHtml(
    item: PendingReminder,
    content: { title: string; body: string; ctaLabel: string },
    user: { name?: string; display_name?: string } | undefined,
    path: string,
  ): string {
    const name = user?.display_name || user?.name || "there";
    const app = this.appUrl();
    const why = this.asksWhy(item)
      ? `
        <div style="margin:32px 0 0;padding:20px;border-radius:16px;background:#f4f4f5;">
          <p style="margin:0 0 12px;font-weight:600;">Not coming back? One tap tells us why:</p>
          ${LEAVE_REASONS.map((r) => `
            <a href="${app}${this.leavePath(item, r.key)}"
               style="display:inline-block;margin:0 6px 8px 0;padding:8px 14px;border-radius:9999px;background:#ffffff;color:#1f1f1f;text-decoration:none;font-size:14px;">
              ${this.htmlEscape(r.label)}
            </a>`).join("")}
        </div>`
      : "";
    return `
      <div style="font-family:Inter,Arial,sans-serif;color:#1f1f1f;line-height:1.6;max-width:560px;">
        <h2 style="margin:0 0 8px;font-size:22px;">${this.htmlEscape(content.title)}</h2>
        <p style="margin:0 0 16px;color:#6b7280;">Hi ${this.htmlEscape(name)},</p>
        <p style="margin:0 0 24px;">${this.htmlEscape(content.body)}</p>
        <a href="${app}${path}"
           style="display:inline-block;background:#F8A31A;color:#1f1f1f;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:9999px;">
          ${this.htmlEscape(content.ctaLabel)}
        </a>
        ${why}
        <p style="margin:28px 0 0;font-size:13px;color:#9ca3af;">— ${APP_BRAND_NAME}</p>
      </div>`;
  }

  // ─── De-duplication ledger ────────────────────────────────────────────────────

  /**
   * Returns true when this run claimed the slot. The conflict target is the
   * per-period key; until migration 20261117120000 is applied that index does
   * not exist, so it falls back to the old key (and the new stages and types
   * are refused by the old CHECK — they simply wait for the migration).
   */
  private async claim(item: PendingReminder): Promise<boolean> {
    const body = JSON.stringify({
      subscription_type: item.type,
      subscription_id: item.subscriptionId,
      stage: item.stage,
      user_id: item.userId,
      expiration_date: item.expirationStr,
    });
    const attempt = (target: string) => this.supabaseRest<any[]>(
      `/subscription_expiration_notifications?on_conflict=${target}`,
      { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body },
    );
    try {
      const rows = await attempt("subscription_type,subscription_id,stage,expiration_date");
      return Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      const msg = (err as Error).message;
      if (/unique or exclusion constraint/i.test(msg)) {
        try {
          const rows = await attempt("subscription_type,subscription_id,stage");
          return Array.isArray(rows) && rows.length > 0;
        } catch (err2) {
          this.logger.warn(`claim failed for ${item.type}:${item.subscriptionId}:${item.stage}: ${(err2 as Error).message}`);
          return false;
        }
      }
      this.logger.warn(`claim failed for ${item.type}:${item.subscriptionId}:${item.stage}: ${msg}`);
      return false;
    }
  }

  private ledgerFilter(item: PendingReminder): string {
    return `subscription_type=eq.${item.type}&subscription_id=eq.${encodeURIComponent(item.subscriptionId)}` +
      `&stage=eq.${item.stage}&expiration_date=eq.${item.expirationStr}`;
  }

  private async markMethods(item: PendingReminder, methods: string[]): Promise<void> {
    try {
      await this.supabaseRest(`/subscription_expiration_notifications?${this.ledgerFilter(item)}`, {
        method: "PATCH", body: JSON.stringify({ methods_sent: methods }),
      });
    } catch { /* best effort */ }
  }

  private async releaseClaim(item: PendingReminder): Promise<void> {
    try {
      await this.supabaseRest(`/subscription_expiration_notifications?${this.ledgerFilter(item)}`, { method: "DELETE" });
    } catch { /* best effort */ }
  }

  /**
   * Plans by the id a subscription row holds. Food and cleaning rows hold the
   * LEGACY plan id (its mirror's source_plan_id); universal rows hold the
   * universal id. The checkout accepts either, so the key is whichever the row
   * had — that is the id the link carries.
   */
  private async lookupPlans(ids: string[], legacy: boolean): Promise<Map<string, PlanInfo>> {
    const map = new Map<string, PlanInfo>();
    const unique = Array.from(new Set(ids.filter(Boolean).map(String)));
    if (!unique.length) return map;
    try {
      const col = legacy ? "source_plan_id" : "id";
      const rows = await this.supabaseRest<any[]>(
        `/provider_plans?${col}=in.(${unique.map((id) => `"${id}"`).join(",")})&select=id,source_plan_id,name,status,period`,
      );
      for (const r of rows ?? []) {
        map.set(String(legacy ? r.source_plan_id : r.id), {
          name: r.name,
          active: String(r.status ?? "active") === "active",
          oneTime: String(r.period ?? "") === "one_time",
        });
      }
    } catch (err) {
      this.logger.warn(`Plan lookup failed: ${(err as Error).message}`);
    }
    return map;
  }

  /** Legacy cleaning provider id → its universal row and owner. */
  private async cleaningOwners(legacyIds: string[]): Promise<Map<string, { id: string; ownerId: string | null }>> {
    const map = new Map<string, { id: string; ownerId: string | null }>();
    const unique = Array.from(new Set(legacyIds.filter(Boolean).map(String)));
    if (!unique.length) return map;
    try {
      const rows = await this.supabaseRest<any[]>(
        `/providers?source_service_key=eq.cleaning&source_provider_id=in.(${unique.map((id) => `"${id}"`).join(",")})` +
          `&select=id,admin_user_id,source_provider_id`,
      );
      for (const r of rows ?? []) {
        map.set(String(r.source_provider_id), { id: String(r.id), ownerId: r.admin_user_id ? String(r.admin_user_id) : null });
      }
    } catch (err) {
      this.logger.warn(`Owner lookup failed: ${(err as Error).message}`);
    }
    return map;
  }

  /** Users who hold a live subscription in this table — a win-back would be noise. */
  private async usersWithLive(table: string, statusCol: string, userIds: string[]): Promise<Set<string>> {
    const set = new Set<string>();
    const unique = Array.from(new Set(userIds.filter(Boolean).map(String)));
    if (!unique.length) return set;
    try {
      const rows = await this.supabaseRest<any[]>(
        `${table}?${statusCol}=in.(active,pending_schedule,paused)&user_id=in.(${unique.map((id) => `"${id}"`).join(",")})&select=user_id`,
      );
      for (const r of rows ?? []) set.add(String(r.user_id));
    } catch (err) {
      // Unknown means "do not chase" — a wrong win-back is worse than none.
      this.logger.warn(`Live-subscription lookup on ${table} failed: ${(err as Error).message}`);
      unique.forEach((id) => set.add(id));
    }
    return set;
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
