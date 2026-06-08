import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccountNotificationsService } from "./account-notifications.service";

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "America/Tegucigalpa";

/** Convert "YYYY-MM-DD" + "HH:MM:SS" in business TZ to a UTC Date. */
function slotToUtc(date: string, startTime: string): Date {
  const localStr = `${date}T${startTime.slice(0, 5)}`;
  // Use Intl to find the UTC offset for that local time in the business timezone
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(`${date}T${startTime.slice(0, 8)}`));
    // Approximate: parse "YYYY-MM-DDTHH:MM" and treat as business-local time
    // Then get its UTC equivalent via a dummy Date parse
    const dummy = new Date(localStr);
    const offset = new Date(
      new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12: false })
      .format(dummy)
    ).getTime() - dummy.getTime();
    return new Date(dummy.getTime() - offset);
  } catch {
    // Fallback: treat as UTC
    return new Date(`${date}T${startTime.slice(0, 8)}Z`);
  }
}

@Injectable()
export class CleaningReminderService {
  private readonly logger = new Logger(CleaningReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: AccountNotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ─── Supabase REST helper ─────────────────────────────────────────────────

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

  // ─── Schedule reminder jobs for new bookings ──────────────────────────────

  /**
   * Called after bookings are created. Creates a reminder job for each booking
   * for the correct recipient (direct user or linked client's user).
   */
  async scheduleForBookings(bookingIds: string[]): Promise<void> {
    if (!bookingIds.length) return;
    try {
      // Load bookings with slot info
      const bookings = await this.supabaseRest<any[]>(
        `/cleaning_bookings?select=id,user_id,client_id,status,slot_id,cleaning_available_slots(date,start_time)&id=in.(${bookingIds.join(",")})`,
      );

      for (const booking of bookings) {
        if (booking.status === "cancelled") continue;
        const slot = booking.cleaning_available_slots;
        if (!slot?.date || !slot?.start_time) continue;

        // Resolve recipient user
        const recipientUserId = await this.resolveRecipientUserId(booking);
        if (!recipientUserId) continue;

        // Get user preferences for reminder timing
        const prefs = await this.getUserPrefsRaw(recipientUserId);
        if (!prefs.reminder_enabled) continue;

        const slotUtc = slotToUtc(slot.date, slot.start_time);
        const scheduledAt = new Date(slotUtc.getTime() - prefs.reminder_minutes_before * 60 * 1000);

        // Skip if cleaning is in the past or within 5 min
        if (scheduledAt.getTime() <= Date.now() + 5 * 60 * 1000) continue;

        // Upsert reminder job (UNIQUE on booking_id + user_id prevents duplicates)
        try {
          await this.supabaseRest("/cleaning_reminder_jobs?on_conflict=booking_id,user_id", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
            body: JSON.stringify({
              booking_id: booking.id,
              user_id:    recipientUserId,
              scheduled_at: scheduledAt.toISOString(),
              status: "pending",
            }),
          });
        } catch (e) {
          this.logger.warn(`Could not schedule reminder for booking ${booking.id}: ${(e as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`scheduleForBookings error: ${(err as Error).message}`);
    }
  }

  // ─── Process due reminders (called by cron or frontend trigger) ─────────────

  /**
   * Scans upcoming bookings directly — no pre-created jobs needed.
   * Safe to call frequently; deduplication via cleaning_reminder_jobs UNIQUE(booking_id, user_id).
   */
  async processDueReminders(): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
    const stats = { processed: 0, sent: 0, skipped: 0, failed: 0 };
    const now = new Date();

    try {
      // Look-ahead: find bookings in the next 25 hours (covers 1-day-before reminders).
      // Use the *business* calendar date (Honduras), not the UTC date — they can differ by up to 6 h.
      const toBusinessDateStr = (d: Date) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

      const todayStr      = toBusinessDateStr(now);
      const lookAheadDate = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      const lookAheadStr  = toBusinessDateStr(lookAheadDate);

      const upcomingBookings = await this.supabaseRest<any[]>(
        `/cleaning_bookings?select=id,user_id,client_id,status,slot_id,cleaning_available_slots(date,start_time,end_time)&status=eq.booked&cleaning_available_slots.date=gte.${todayStr}&cleaning_available_slots.date=lte.${lookAheadStr}&limit=200`,
      );

      if (!upcomingBookings?.length) return stats;

      for (const booking of upcomingBookings) {
        const slot = booking.cleaning_available_slots;
        if (!slot?.date || !slot?.start_time) continue;

        // Resolve recipient
        const userId = await this.resolveRecipientUserId(booking);
        if (!userId) continue;

        // Get user preferences
        const prefs = await this.getUserPrefsRaw(userId);
        if (!prefs.reminder_enabled) continue;

        // Calculate when the reminder should fire
        const slotUtc = slotToUtc(slot.date, slot.start_time);
        const reminderAt = new Date(slotUtc.getTime() - prefs.reminder_minutes_before * 60 * 1000);

        // Only process if we're within the reminder window:
        // reminderAt <= now < slotUtc (cleaning hasn't started yet)
        if (reminderAt > now) continue;  // too early
        if (slotUtc <= now) continue;    // cleaning already started / passed

        // Check if already sent (deduplication)
        const existingJobs = await this.supabaseRest<any[]>(
          `/cleaning_reminder_jobs?booking_id=eq.${encodeURIComponent(booking.id)}&user_id=eq.${encodeURIComponent(userId)}&select=id,status`,
        );
        const alreadySent = existingJobs?.some((j) => j.status === "sent");
        if (alreadySent) continue;

        stats.processed++;
        try {
          // Ensure job record exists (upsert)
          const jobRows = await this.supabaseRest<any[]>(
            `/cleaning_reminder_jobs?on_conflict=booking_id,user_id`,
            {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=representation" },
              body: JSON.stringify({
                booking_id:   booking.id,
                user_id:      userId,
                scheduled_at: reminderAt.toISOString(),
                status:       "pending",
              }),
            },
          );
          const jobId = jobRows?.[0]?.id ?? existingJobs?.[0]?.id;

          // Send the reminder
          const result = await this.processBookingReminder(booking, slot, userId, prefs, jobId);
          if (result === "sent")    stats.sent++;
          else if (result === "skipped") stats.skipped++;
        } catch (err) {
          stats.failed++;
          this.logger.error(`Reminder for booking ${booking.id} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`processDueReminders error: ${(err as Error).message}`);
    }

    return stats;
  }

  private async processBookingReminder(
    booking: any,
    slot: any,
    userId: string,
    prefs: any,
    jobId?: string,
  ): Promise<"sent" | "skipped"> {
    // Load user info
    const users = await this.supabaseRest<any[]>(
      `/users?id=eq.${encodeURIComponent(userId)}&select=id,email,name,display_name&limit=1`,
    );
    const user = users?.[0];
    if (!user) {
      if (jobId) await this.markJob(jobId, "skipped", { reason: "user not found" });
      return "skipped";
    }

    const timeStr = this.formatTime(slot?.start_time);
    const dateStr = slot?.date ? this.formatDate(slot.date) : "today";
    const accessNote = booking.access_instructions || prefs.access_instructions || null;
    const method = prefs.reminder_method || "all";
    const methodsSent: string[] = [];

    if (method === "all" || method === "in_app") {
      await this.notifications.create({
        recipientUserId: userId,
        category: "reminder",
        type: "reminder_general",
        title: "🧹 Cleaning Reminder",
        body: `Your cleaning is ${dateStr} at ${timeStr}. Please make sure the door is unlocked and accessible.${accessNote ? ` Note: ${accessNote}` : ""}`,
        actionUrl: "/my-subscriptions",
      });
      methodsSent.push("in_app");
    }

    if ((method === "all" || method === "email") && user.email) {
      await this.sendReminderEmail(user, timeStr, dateStr, accessNote);
      methodsSent.push("email");
    }

    if (jobId) await this.markJob(jobId, "sent", { methods: methodsSent });
    return "sent";
  }

  /** @deprecated Used only for pre-existing job records */
  private async processJob(job: any): Promise<"sent" | "skipped"> {
    const bookings = await this.supabaseRest<any[]>(
      `/cleaning_bookings?id=eq.${encodeURIComponent(job.booking_id)}&select=id,status,user_id,client_id,slot_id,access_instructions,cleaning_available_slots(date,start_time,end_time)&limit=1`,
    );
    const booking = bookings?.[0];
    if (!booking || booking.status === "cancelled") {
      await this.markJob(job.id, "skipped", { reason: "booking cancelled or missing" });
      return "skipped";
    }
    const prefs = await this.getUserPrefsRaw(job.user_id);
    if (!prefs.reminder_enabled) {
      await this.markJob(job.id, "skipped", { reason: "reminders disabled" });
      return "skipped";
    }
    return this.processBookingReminder(booking, booking.cleaning_available_slots, job.user_id, prefs, job.id);
  }

  // ─── Email template ───────────────────────────────────────────────────────

  private async sendReminderEmail(
    user: { email: string; name?: string; display_name?: string },
    timeStr: string,
    dateStr: string,
    accessNote: string | null,
  ) {
    const name = user.display_name || user.name || "there";
    const accessSection = accessNote
      ? `<p style="margin:16px 0;padding:12px 16px;background:#f5f5f5;border-radius:8px;font-size:14px;"><strong>Access note:</strong> ${this.htmlEscape(accessNote)}</p>`
      : "";

    await this.mail.sendMail({
      to: user.email,
      subject: `Cleaning Reminder – Door Access Needed (${timeStr})`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;color:#1f1f1f;line-height:1.6;max-width:560px;">
          <h2 style="margin:0 0 8px;font-size:22px;">🧹 Cleaning Reminder</h2>
          <p style="margin:0 0 16px;color:#6b7280;">Hi ${this.htmlEscape(name)},</p>
          <p style="margin:0 0 16px;">Your cleaning is scheduled <strong>${this.htmlEscape(dateStr)} at ${this.htmlEscape(timeStr)}</strong>.</p>
          <p style="margin:0 0 16px;">Please make sure the apartment door is <strong>unlocked or accessible</strong> so the cleaning team can enter.</p>
          ${accessSection}
          <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">— ProsperaSub Cleaning Team</p>
        </div>`,
      text: [
        `Cleaning Reminder`,
        ``,
        `Hi ${name},`,
        ``,
        `Your cleaning is scheduled ${dateStr} at ${timeStr}.`,
        `Please make sure the apartment door is unlocked or accessible so the cleaning team can enter.`,
        accessNote ? `Access note: ${accessNote}` : "",
        ``,
        `— ProsperaSub Cleaning Team`,
      ].filter((l) => l !== undefined).join("\n"),
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async resolveRecipientUserId(booking: any): Promise<string | null> {
    if (booking.user_id) return booking.user_id;
    if (booking.client_id) {
      try {
        const clients = await this.supabaseRest<any[]>(
          `/cleaning_clients?id=eq.${encodeURIComponent(booking.client_id)}&select=user_id&limit=1`,
        );
        return clients?.[0]?.user_id ?? null;
      } catch { return null; }
    }
    return null;
  }

  private async getUserPrefsRaw(userId: string) {
    try {
      const rows = await this.supabaseRest<any[]>(
        `/user_cleaning_preferences?user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      );
      if (rows?.length) return rows[0];
    } catch { /* use defaults */ }
    return { reminder_enabled: true, reminder_method: "all", reminder_minutes_before: 60, access_instructions: null };
  }

  private async markJob(id: string, status: string, meta: Record<string, any>) {
    try {
      const patch: any = { status, error_message: meta.error ?? null };
      if (status === "sent") patch.sent_at = new Date().toISOString();
      if (meta.methods) patch.methods_sent = JSON.stringify(meta.methods);
      await this.supabaseRest(`/cleaning_reminder_jobs?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify(patch),
      });
    } catch (err) {
      this.logger.warn(`markJob ${id} → ${status} failed: ${(err as Error).message}`);
    }
  }

  private formatTime(t?: string): string {
    if (!t) return "scheduled time";
    const [h, m] = t.split(":").map(Number);
    const suffix = h >= 12 ? "PM" : "AM";
    const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
  }

  private formatDate(d: string): string {
    try {
      // Compare against the *business* calendar date (Honduras), not the UTC server date.
      const toLocalDate = (date: Date) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
      const now      = new Date();
      const todayStr = toLocalDate(now);
      const tmrwStr  = toLocalDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      if (d === todayStr)  return "today";
      if (d === tmrwStr)   return "tomorrow";
      const dt = new Date(`${d}T12:00:00Z`);
      return dt.toLocaleDateString("en-US", { timeZone: BUSINESS_TZ, weekday: "long", month: "short", day: "numeric" });
    } catch { return d; }
  }

  private htmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
