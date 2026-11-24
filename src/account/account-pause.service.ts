import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AccountNotificationsService } from "./account-notifications.service";

/**
 * Letting a customer put a membership on hold instead of cancelling it.
 *
 * Until this existed, "paused" was a status only an admin or the business
 * could set. A customer leaving the island for a month had one button:
 * Cancel. Pause is the answer most of them actually wanted, and the one that
 * brings them back (industry data: three in four paused subscribers resume).
 *
 * **A pause moves the end date, it does not refund.** The customer has paid
 * for N days of access; pausing for 30 days means access stops today and the
 * paid period ends 30 days later than it would have. Nothing is charged and
 * nothing is returned. Resuming early gives the unused pause days back by
 * pulling the end date in again.
 *
 * Scope: universal memberships (`provider_subscriptions`: beach and every
 * plan). Cleaning has its own scheduling pause and food derives its end date
 * from weeks, so neither is touched here.
 *
 * Limits, so a pause cannot become free extra time on a plan nobody renews:
 *  - only an active, paid plan inside its period can be paused;
 *  - not a plan PayPal renews by itself — PayPal would keep charging on its
 *    own calendar while the plan sat on hold;
 *  - at most MAX_PAUSE_DAYS_PER_PERIOD days per paid period, counted from the
 *    period's start date (a renewal starts a new period and a fresh allowance).
 *
 * The pause lives in `metadata.pause` ({ from, until, days }) — no migration —
 * and the daily cron (SubscriptionExpirationService) flips a row whose pause
 * has run out back to active.
 */

/** The lengths offered to the customer. Anything else is refused. */
export const PAUSE_OPTIONS_DAYS = [14, 30, 60] as const;
export const MAX_PAUSE_DAYS_PER_PERIOD = 90;

const PAUSABLE_SERVICES: Record<string, string> = {
  beach: "membership",
  plan: "subscription",
};

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/Tegucigalpa";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PauseInfo {
  /** YYYY-MM-DD, the first day without access. */
  from: string;
  /** YYYY-MM-DD, the day access comes back. */
  until: string;
  days: number;
}

export interface PauseResult {
  ok: true;
  status: "paused" | "active";
  /** The paid period's end after this change. */
  endsOn: string | null;
  pause: PauseInfo | null;
  /** Pause days still available in this paid period. */
  pauseDaysLeft: number;
}

/** YYYY-MM-DD in the business time zone. */
export function businessDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** Calendar arithmetic on YYYY-MM-DD strings, free of time zones. */
export function addDaysStr(day: string, days: number): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** The metadata with the pause taken off, everything else kept. */
export function withoutPause(metadata: unknown): Record<string, unknown> {
  const meta = metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  delete meta.pause;
  return meta;
}

/** Days of pause already used in the period that started on `startDate`. */
export function pauseDaysUsed(metadata: any, startDate: string | null): number {
  if (!metadata || typeof metadata !== "object") return 0;
  if (String(metadata.pause_period_start ?? "") !== String(startDate ?? "")) return 0;
  return Math.max(0, Number(metadata.pause_days_used) || 0);
}

interface SubRow {
  id: string;
  user_id: string | null;
  status: string | null;
  payment_status: string | null;
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean | null;
  metadata: any;
}

@Injectable()
export class AccountPauseService {
  private readonly logger = new Logger(AccountPauseService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: AccountNotificationsService,
  ) {}

  async pause(
    userId: string,
    service: string,
    subscriptionId: string,
    days: number,
    email?: string,
    now: Date = new Date(),
  ): Promise<PauseResult> {
    const label = this.labelFor(service);
    const length = Number(days);
    if (!(PAUSE_OPTIONS_DAYS as readonly number[]).includes(length)) {
      throw new BadRequestException(`A pause can be ${PAUSE_OPTIONS_DAYS.join(", ")} days.`);
    }

    const sub = await this.loadOwned(userId, subscriptionId, email);
    const today = businessDateStr(now);
    const status = String(sub.status ?? "").toLowerCase();

    if (status === "paused") throw new BadRequestException("This subscription is already paused.");
    if (status !== "active") throw new BadRequestException(`A ${status || "pending"} subscription can't be paused.`);
    if (String(sub.payment_status ?? "").toLowerCase() !== "paid") {
      throw new BadRequestException("Only a paid subscription can be paused.");
    }
    if (!sub.end_date || sub.end_date.slice(0, 10) < today) {
      throw new BadRequestException("This subscription has already ended.");
    }
    if (sub.start_date && sub.start_date.slice(0, 10) > today) {
      throw new BadRequestException("This subscription hasn't started yet.");
    }
    if (sub.auto_renew) {
      throw new BadRequestException("A plan that renews automatically through PayPal can't be paused yet.");
    }

    const used = pauseDaysUsed(sub.metadata, sub.start_date);
    const left = MAX_PAUSE_DAYS_PER_PERIOD - used;
    if (length > left) {
      throw new BadRequestException(
        left > 0
          ? `You have ${left} pause days left in this period.`
          : "You've used all the pause days for this period.",
      );
    }

    const pause: PauseInfo = { from: today, until: addDaysStr(today, length), days: length };
    const newEnd = addDaysStr(sub.end_date, length);
    const metadata = {
      ...withoutPause(sub.metadata),
      pause,
      pause_period_start: sub.start_date ?? null,
      pause_days_used: used + length,
    };

    // Guarded on the status we checked, so two taps cannot pause twice.
    const updated = await this.patch(
      `provider_subscriptions?id=eq.${encodeURIComponent(sub.id)}&status=eq.active`,
      { status: "paused", end_date: newEnd, metadata, updated_at: now.toISOString() },
    );
    if (!updated) throw new BadRequestException("This subscription changed in the meantime. Refresh and try again.");

    await this.notify(sub, "Subscription paused",
      `Your ${label} is paused until ${pause.until}. Your paid period now ends on ${newEnd}. You can resume earlier at any time.`);

    this.logger.log(`[pause] ${service}:${sub.id} ${length}d until ${pause.until}, end ${sub.end_date} -> ${newEnd}`);
    return { ok: true, status: "paused", endsOn: newEnd, pause, pauseDaysLeft: left - length };
  }

  /** End the customer's own pause early. The unused days come off the end date. */
  async unpause(
    userId: string,
    service: string,
    subscriptionId: string,
    email?: string,
    now: Date = new Date(),
  ): Promise<PauseResult> {
    const label = this.labelFor(service);
    const sub = await this.loadOwned(userId, subscriptionId, email);
    const status = String(sub.status ?? "").toLowerCase();
    const pause: PauseInfo | undefined = sub.metadata?.pause;

    if (status !== "paused") throw new BadRequestException("This subscription isn't paused.");
    if (!pause?.until) {
      // Paused by the business or an admin — theirs to lift.
      throw new BadRequestException("This subscription was paused by the business. Contact them to resume it.");
    }

    const today = businessDateStr(now);
    const unused = Math.max(0, daysBetween(today, pause.until));
    const newEnd = sub.end_date ? addDaysStr(sub.end_date, -unused) : null;
    const used = Math.max(0, pauseDaysUsed(sub.metadata, sub.start_date) - unused);
    const metadata = { ...withoutPause(sub.metadata), pause_days_used: used };

    const updated = await this.patch(
      `provider_subscriptions?id=eq.${encodeURIComponent(sub.id)}&status=eq.paused`,
      { status: "active", ...(newEnd ? { end_date: newEnd } : {}), metadata, updated_at: now.toISOString() },
    );
    if (!updated) throw new BadRequestException("This subscription changed in the meantime. Refresh and try again.");

    await this.notify(sub, "Subscription resumed",
      newEnd ? `Your ${label} is active again and runs until ${newEnd}.` : `Your ${label} is active again.`);

    this.logger.log(`[unpause] ${service}:${sub.id} ${unused}d unused, end ${sub.end_date} -> ${newEnd}`);
    return { ok: true, status: "active", endsOn: newEnd, pause: null, pauseDaysLeft: MAX_PAUSE_DAYS_PER_PERIOD - used };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private labelFor(service: string): string {
    const label = PAUSABLE_SERVICES[service];
    if (!label) throw new BadRequestException(`"${service}" subscriptions can't be paused here.`);
    return label;
  }

  /** The row, after checking it belongs to the caller (same rule as cancellation). */
  private async loadOwned(userId: string, subscriptionId: string, email?: string): Promise<SubRow> {
    if (!UUID_RE.test(subscriptionId)) throw new NotFoundException("Subscription not found.");
    const rows = await this.rest<SubRow[]>(
      `provider_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}` +
        `&select=id,user_id,status,payment_status,start_date,end_date,auto_renew,metadata&limit=1`,
    );
    const sub = rows?.[0];
    if (!sub) throw new NotFoundException("Subscription not found.");

    // A Google-login customer carries a `google-…` subject while the row holds
    // their canonical users.id — fall back to the email, as cancellation does.
    let owns = String(sub.user_id ?? "") === String(userId);
    if (!owns && email) {
      const users = await this.rest<Array<{ id: string }>>(
        `users?select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
      );
      owns = !!users?.[0]?.id && String(sub.user_id ?? "") === String(users[0].id);
    }
    if (!owns) throw new ForbiddenException("This subscription is not yours.");
    return sub;
  }

  /** A receipt in the notification centre. Failure never undoes the change. */
  private async notify(sub: SubRow, title: string, body: string): Promise<void> {
    if (!sub.user_id) return;
    try {
      await this.notifications.create({
        recipientUserId: String(sub.user_id),
        category: "subscription",
        type: "subscription_created",
        title,
        body,
        relatedEntityType: "provider_subscriptions",
        relatedEntityId: String(sub.id),
        actionUrl: "/my-subscriptions",
      });
    } catch (err) {
      this.logger.warn(`Pause notice failed for ${sub.id}: ${(err as Error).message}`);
    }
  }

  // ─── Supabase REST ──────────────────────────────────────────────────────────

  private restBase(): { base: string; key: string } | null {
    const base = this.config.get<string>("SUPABASE_URL")?.replace(/\/$/, "");
    const key =
      this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
      this.config.get<string>("SUPABASE_ANON_KEY");
    if (!base || !key) return null;
    return { base, key };
  }

  private async rest<T>(path: string): Promise<T | null> {
    const cfg = this.restBase();
    if (!cfg) return null;
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  /** PATCH and say whether a row actually changed. */
  private async patch(path: string, body: Record<string, unknown>): Promise<boolean> {
    const cfg = this.restBase();
    if (!cfg) throw new Error("Supabase not configured");
    const res = await fetch(`${cfg.base}/rest/v1/${path}`, {
      method: "PATCH",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Subscription update failed (${res.status}): ${text}`);
    }
    const rows = (await res.json().catch(() => [])) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  }
}
