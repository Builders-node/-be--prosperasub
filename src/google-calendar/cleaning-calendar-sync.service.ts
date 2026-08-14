import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type CleaningBooking } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { GoogleCalendarService, type GoogleCalendarEventItem, type GoogleCalendarEventPayload } from "./google-calendar.service";

const bookingCalendarInclude = Prisma.validator<Prisma.CleaningBookingInclude>()({
  slot: true,
  client: true,
  customPlan: true,
  recurringSchedule: true,
  checklistTemplate: true,
  completionReport: true,
  subscription: {
    include: {
      package: true,
      user: {
        select: {
          email: true,
          name: true,
          displayName: true,
        },
      },
    },
  },
  user: {
    select: {
      email: true,
      name: true,
      displayName: true,
    },
  },
});

type BookingWithCalendarRelations = Prisma.CleaningBookingGetPayload<{ include: typeof bookingCalendarInclude }>;

export function buildGoogleCalendarRRule(frequency: "DAILY" | "WEEKLY" | "MONTHLY", until: Date) {
  const untilUtc = until.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `RRULE:FREQ=${frequency};UNTIL=${untilUtc}`;
}

@Injectable()
export class CleaningCalendarSyncService {
  private readonly logger = new Logger(CleaningCalendarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  getSharedAdminCalendarId() {
    return this.googleCalendar.getSharedAdminCleaningCalendarId();
  }

  /**
   * The calendar a booking belongs on: its provider's own, or the shared one.
   *
   * Every cleaning booking used to land in the single calendar named by
   * GOOGLE_CLEANING_CALENDAR_ID, so a car wash and an apartment clean sat side
   * by side with nothing but a line of description to tell them apart, and the
   * staff of one business saw the schedule of the other. Beach courts have had
   * a per-court calendar all along; cleaning simply never passed one.
   *
   * Returns undefined when the provider has no calendar of its own, which the
   * calendar service reads as "use the shared one" — so nothing changes for a
   * provider until an admin gives it one.
   */
  private readonly calendarIdCache = new Map<string, string | undefined>();

  async resolveCalendarId(bookingId: string): Promise<string | undefined> {
    if (this.calendarIdCache.has(bookingId)) return this.calendarIdCache.get(bookingId);
    let calendarId: string | undefined;
    try {
      // booking -> subscription -> package -> legacy provider -> universal row
      const rows = await this.supabaseRest<Array<{ subscription_id: string | null }>>(
        `/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}&select=subscription_id&limit=1`,
      );
      const subId = rows?.[0]?.subscription_id;
      if (subId) {
        const subs = await this.supabaseRest<Array<{ package_id: string | null }>>(
          `/cleaning_subscriptions?id=eq.${encodeURIComponent(subId)}&select=package_id&limit=1`,
        );
        const pkgId = subs?.[0]?.package_id;
        if (pkgId) {
          const pkgs = await this.supabaseRest<Array<{ provider_id: string | null }>>(
            `/cleaning_packages?id=eq.${encodeURIComponent(pkgId)}&select=provider_id&limit=1`,
          );
          const legacyId = pkgs?.[0]?.provider_id;
          if (legacyId) {
            const provs = await this.supabaseRest<Array<{ google_calendar_id: string | null }>>(
              `/providers?source_service_key=eq.cleaning&source_provider_id=eq.${encodeURIComponent(legacyId)}&select=google_calendar_id&limit=1`,
            );
            calendarId = provs?.[0]?.google_calendar_id?.trim() || undefined;
          }
        }
      }
    } catch (e) {
      // A lookup failure must not stop the sync — fall back to the shared
      // calendar, which is where this booking would have gone anyway.
      this.logger.warn(`[sync] could not resolve calendar for booking ${bookingId}: ${(e as Error).message}`);
    }
    this.calendarIdCache.set(bookingId, calendarId);
    return calendarId;
  }

  getConfigurationStatus() {
    return this.googleCalendar.getConfigurationStatus();
  }

  isConfigured() {
    return this.googleCalendar.isConfigured();
  }

  async syncBookingById(bookingId: string) {
    const booking = await this.loadBooking(bookingId);
    if (!booking) throw new NotFoundException("Cleaning booking not found");

    try {
      const payload = this.buildEventPayload(booking);
      const isCancelled = booking.status === "CANCELLED" || booking.status === "cancelled";
      const storedEventId = booking.googleCalendarEventId ?? null;

      const calendarId = await this.resolveCalendarId(bookingId);
      const result = await this.upsertCalendarEvent(bookingId, storedEventId, payload, isCancelled, calendarId);

      await this.prisma.cleaningBooking.update({
        where: { id: bookingId },
        data: {
          googleCalendarEventId: result.id,
          googleCalendarEventLink: result.htmlLink ?? booking.googleCalendarEventLink,
          googleCalendarSyncedAt: new Date(),
          googleCalendarSyncStatus: "synced",
          googleCalendarSyncError: null,
        },
      });

      this.logger.log(`[sync] Booking ${bookingId} → event ${result.id} (${result.action})`);
      // Report the calendar actually written to, not the shared default — the
      // admin needs to know where to look.
      return { ok: true, bookingId, eventId: result.id, action: result.action,
               calendarId: (await this.resolveCalendarId(bookingId)) ?? this.getSharedAdminCalendarId() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed";
      this.logger.warn(`[sync] Booking ${bookingId} failed: ${message}`);
      await this.markSyncFailed(bookingId, message);
      return { ok: false, bookingId, calendarId: this.getSharedAdminCalendarId(), error: message };
    }
  }

  /**
   * Auto-sync every booking whose calendar is out of date. Any create / reschedule
   * / cancel marks the booking `google_calendar_sync_status = 'pending'`, so this
   * picks those up (plus never-synced rows) and upserts/cancels their Google
   * Calendar event. Runs on a frequent cron so admins never sync manually.
   */
  async syncPendingBookings(limit = 100) {
    if (!this.isConfigured()) {
      return { ok: false as const, reason: "not_configured" as const };
    }
    // Bookings flagged out-of-date by a create / reschedule / cancel / complete.
    const rows = await this.supabaseRest<Array<{ id: string }>>(
      `/cleaning_bookings?select=id&google_calendar_sync_status=in.(pending,failed)&limit=${limit}`,
    );

    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const res = await this.syncBookingById(row.id);
        if (res.ok) synced++; else failed++;
      } catch (e) {
        failed++;
        this.logger.warn(`[auto-sync] booking ${row.id} threw: ${(e as Error).message}`);
      }
    }
    this.logger.log(`[auto-sync] processed ${rows.length} pending bookings → ${synced} synced, ${failed} failed`);
    return { ok: true as const, processed: rows.length, synced, failed };
  }

  // ─── Idempotent upsert ────────────────────────────────────────────────────

  private async upsertCalendarEvent(
    bookingId: string,
    storedEventId: string | null,
    payload: GoogleCalendarEventPayload,
    isCancelled: boolean,
    /** The provider's own calendar; undefined means the shared one. */
    calendarId?: string,
  ): Promise<{ id: string; htmlLink?: string | null; action: "created" | "updated" | "cancelled" }> {

    // 0. If the stored event id is shared with another booking (legacy data bug),
    //    do NOT touch it — that would make the two bookings overwrite one event and
    //    "swap". Drop our reference and fall through to create a fresh, unique event.
    if (storedEventId && (await this.eventIdTakenByOtherBooking(storedEventId, bookingId))) {
      this.logger.warn(`[sync] Stored event ${storedEventId} is shared with another booking; creating a fresh event for ${bookingId}`);
      storedEventId = null;
    }

    // 1. Try updating the stored event ID first (fastest path)
    if (storedEventId) {
      try {
        const result = isCancelled
          ? await this.googleCalendar.cancelEvent(storedEventId, payload, calendarId)
          : await this.googleCalendar.updateEvent(storedEventId, payload, calendarId);
        this.logger.log(`[sync] Updated stored event ${storedEventId} for booking ${bookingId}`);
        return { ...result, action: isCancelled ? "cancelled" : "updated" };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!/404|410/.test(msg)) throw err;
        // Event was deleted externally — fall through to find by bookingId
        this.logger.warn(`[sync] Stored event ${storedEventId} not found (${msg}), searching by bookingId`);
      }
    }

    // 2. Search Google Calendar for events tagged with this bookingId
    const byId = await this.googleCalendar.findEventsByBookingId(bookingId, calendarId);
    if (byId.length > 0) {
      const [keep, ...dupes] = byId;
      // Delete duplicates
      for (const dupe of dupes) {
        this.logger.warn(`[sync] Deleting duplicate event ${dupe.id} for booking ${bookingId}`);
        await this.googleCalendar.deleteEvent(dupe.id, calendarId).catch(() => {/* best effort */});
      }
      // Update the survivor
      const result = isCancelled
        ? await this.googleCalendar.cancelEvent(keep.id, payload, calendarId)
        : await this.googleCalendar.updateEvent(keep.id, payload, calendarId);
      this.logger.log(`[sync] Found & updated event ${keep.id} by bookingId for booking ${bookingId}${dupes.length ? ` (deleted ${dupes.length} duplicate(s))` : ""}`);
      return { ...result, action: isCancelled ? "cancelled" : "updated" };
    }

    // 3. Fallback: adopt a legacy event (no extendedProperties) only when it is an
    //    EXACT match — same full title AND same date. Using the full title (not just
    //    the "Cleaning" prefix) plus a DB guard prevents two different bookings from
    //    ever being mapped onto the same calendar event id.
    const fullTitle = payload.summary.replace(/^\[Cancelled\]\s*/i, "");
    const dateStr = payload.start.toISOString().slice(0, 10);
    const byTitle = await this.googleCalendar.findEventsByFallback(fullTitle, dateStr, calendarId);
    const matchByTime = byTitle.find((e) => {
      const eStart = e.start?.dateTime ?? e.start?.date ?? "";
      const sameDay = eStart.startsWith(dateStr);
      const sameTitle = (e.summary ?? "").replace(/^\[Cancelled\]\s*/i, "") === fullTitle;
      return sameDay && sameTitle;
    });

    if (matchByTime && !(await this.eventIdTakenByOtherBooking(matchByTime.id, bookingId))) {
      this.logger.log(`[sync] Found event ${matchByTime.id} by title fallback for booking ${bookingId}`);
      const result = isCancelled
        ? await this.googleCalendar.cancelEvent(matchByTime.id, payload, calendarId)
        : await this.googleCalendar.updateEvent(matchByTime.id, payload, calendarId);
      return { ...result, action: isCancelled ? "cancelled" : "updated" };
    }
    if (matchByTime) {
      this.logger.warn(`[sync] Skipping reuse of event ${matchByTime.id} — already owned by another booking; creating a fresh event for ${bookingId}`);
    }

    // 4. Truly new — create it
    if (isCancelled) {
      // Don't create new events for already-cancelled bookings with no existing event
      this.logger.log(`[sync] Skipping create for cancelled booking ${bookingId} — no existing event`);
      return { id: storedEventId ?? "", htmlLink: null, action: "cancelled" };
    }

    const result = await this.googleCalendar.createEvent(payload, calendarId);
    this.logger.log(`[sync] Created new event ${result.id} for booking ${bookingId}${calendarId ? ` on ${calendarId}` : ""}`);
    return { ...result, action: "created" };
  }

  /**
   * Reconcile the shared cleaning calendar with the database. Conservative by
   * design — it only DELETES an event when the DB *definitively* confirms (HTTP
   * 200, empty result) that the tagged booking no longer exists, or when it's a
   * duplicate of a booking already seen. Any lookup error/uncertainty is skipped,
   * never deleted. Untagged events (no bookingId) are always left alone.
   * Manual-only (Reconcile button); intentionally not on a cron.
   */
  async reconcileCalendar(opts?: { daysBehind?: number; daysAhead?: number }) {
    if (!this.isConfigured()) {
      return { ok: false, reason: "not_configured" as const };
    }
    const daysBehind = opts?.daysBehind ?? 14;
    const daysAhead = opts?.daysAhead ?? 120;
    const now = Date.now();
    const timeMin = new Date(now - daysBehind * 86_400_000).toISOString();
    const timeMax = new Date(now + daysAhead * 86_400_000).toISOString();

    const events = await this.googleCalendar.listEvents(timeMin, timeMax);
    const stats = { scanned: events.length, orphansDeleted: 0, duplicatesDeleted: 0, untagged: 0, skipped: 0, errors: 0 };
    const seenBookingIds = new Set<string>();

    for (const e of events) {
      const bookingId = e.extendedProperties?.private?.bookingId;
      if (!bookingId) { stats.untagged++; continue; }

      const lookup = await this.lookupBookingForReconcile(bookingId);

      // SAFETY: only ever delete when the DB *definitively* confirms the booking
      // is gone ("absent"). On any lookup error/uncertainty we skip — never delete.
      if (lookup === "error") { stats.skipped++; continue; }

      if (lookup === "absent") {
        try { await this.googleCalendar.deleteEvent(e.id); stats.orphansDeleted++; }
        catch { stats.errors++; }
        continue;
      }

      // Booking exists. Cancelled bookings keep their "[Cancelled]" event.
      if (lookup.status === "cancelled") continue;

      // Duplicate event for the same booking → keep the first, drop the rest.
      if (seenBookingIds.has(bookingId)) {
        try { await this.googleCalendar.deleteEvent(e.id); stats.duplicatesDeleted++; }
        catch { stats.errors++; }
        continue;
      }
      seenBookingIds.add(bookingId);
    }

    return { ok: true as const, ...stats };
  }

  /**
   * Restore/resync EVERY cleaning booking's Google Calendar event using REST only
   * (no Prisma — works on prod serverless). Recreates missing events, reuses/updates
   * existing ones (idempotent via bookingId tag + title/date fallback), and writes the
   * event id back to the DB. Use this to rebuild the calendar after data loss.
   */
  async restoreAllCalendarEvents() {
    if (!this.isConfigured()) return { ok: false as const, reason: "not_configured" as const };

    const bookings = await this.supabaseRest<any[]>(
      `/cleaning_bookings?select=id,status,location,notes,user_id,google_calendar_event_id,` +
      `cleaning_available_slots(date,start_time,end_time),` +
      `cleaning_clients(company_name,location)&limit=2000`,
    ).catch(() => null);
    if (!Array.isArray(bookings)) return { ok: false as const, reason: "fetch_failed" as const };

    // Resolve user names for bookings without a linked client (direct user bookings).
    const userIds = [...new Set(bookings.filter((b) => !b.cleaning_clients && b.user_id).map((b) => b.user_id))];
    const userMap = new Map<string, any>();
    if (userIds.length) {
      const users = await this.supabaseRest<any[]>(
        `/users?id=in.(${userIds.map((id) => `"${id}"`).join(",")})&select=id,name,display_name,email`,
      ).catch(() => []);
      (users ?? []).forEach((u) => userMap.set(String(u.id), u));
    }

    // Clean slate: delete every existing cleaning event in a wide window, so the
    // rebuild produces exactly one correct event per booking (no merges/dupes).
    const wideMin = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const wideMax = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const existing = await this.googleCalendar.listEvents(wideMin, wideMax).catch(() => [] as any[]);
    let deleted = 0;
    for (const e of existing) {
      const isCleaning = String(e.summary ?? "").startsWith("Cleaning") || Boolean(e.extendedProperties?.private?.bookingId);
      if (isCleaning) {
        try { await this.googleCalendar.deleteEvent(e.id); deleted++; } catch { /* best effort */ }
      }
    }

    const stats = { total: bookings.length, deleted, created: 0, skipped: 0, errors: 0 };

    for (const b of bookings) {
      const slot = b.cleaning_available_slots;
      if (!slot?.date || !slot?.start_time || !slot?.end_time) { stats.skipped++; continue; }

      const u = userMap.get(String(b.user_id));
      const clientName =
        b.cleaning_clients?.company_name ||
        u?.display_name || u?.name || u?.email || "Cleaning client";
      const building = b.location || b.cleaning_clients?.location || "Prospera Village";
      const planName = "Cleaning booking";
      const isCancelled = String(b.status ?? "").toLowerCase() === "cancelled";
      const titleBase = `Cleaning - ${clientName}`;
      const hnOffset = "-06:00";

      const payload: GoogleCalendarEventPayload = {
        summary: isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
        location: building,
        description: [`Status: ${b.status ?? "booked"}`, `Client: ${clientName}`, `Plan: ${planName}`, `Booking ID: ${b.id}`].join("\n"),
        start: new Date(`${slot.date}T${String(slot.start_time).slice(0, 5)}:00${hnOffset}`),
        end: new Date(`${slot.date}T${String(slot.end_time).slice(0, 5)}:00${hnOffset}`),
        colorId: isCancelled ? "11" : undefined,
        bookingId: b.id,
      };

      try {
        const result = await this.googleCalendar.createEvent(payload);
        stats.created++;
        if (result.id) {
          await this.supabaseRest(
            `/cleaning_bookings?id=eq.${encodeURIComponent(b.id)}`,
            {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                google_calendar_event_id: result.id,
                google_calendar_event_link: result.htmlLink ?? null,
                google_calendar_sync_status: "synced",
                google_calendar_synced_at: new Date().toISOString(),
              }),
            },
          ).catch(() => {/* best effort */});
        }
      } catch {
        stats.errors++;
      }
    }

    return { ok: true as const, ...stats };
  }

  /**
   * Reconcile lookup. Returns:
   *  - "error"  → query failed / uncertain → caller must NOT delete
   *  - "absent" → DB confirmed (200) the booking row does not exist → safe to delete
   *  - { status } → booking exists
   * Uses only columns that exist on cleaning_bookings (no embeds, no deleted_at).
   */
  private async lookupBookingForReconcile(bookingId: string): Promise<"error" | "absent" | { status: string }> {
    try {
      const rows = await this.supabaseRest<any[]>(
        `/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}&select=id,status&limit=1`,
      );
      if (!Array.isArray(rows)) return "error";
      if (rows.length === 0) return "absent";
      return { status: String(rows[0].status ?? "").toLowerCase() };
    } catch {
      return "error";
    }
  }

  async deleteCalendarEventForBooking(bookingId: string) {
    const booking = await this.prisma.cleaningBooking.findUnique({
      where: { id: bookingId },
      select: { googleCalendarEventId: true },
    });

    let eventId = booking?.googleCalendarEventId ?? null;

    // If no stored ID, search by bookingId extendedProperty
    if (!eventId) {
      const found = await this.googleCalendar.findEventsByBookingId(bookingId);
      eventId = found[0]?.id ?? null;
      // Delete any duplicates
      for (const dupe of found.slice(1)) {
        await this.googleCalendar.deleteEvent(dupe.id).catch(() => {/* best effort */});
      }
    }

    if (!eventId) return { ok: true, bookingId, skipped: true };

    try {
      await this.googleCalendar.deleteEvent(eventId);
      this.logger.log(`[sync] Deleted event ${eventId} for cancelled/deleted booking ${bookingId}`);
      return { ok: true, bookingId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar delete failed";
      await this.markSyncFailed(bookingId, message);
      return { ok: false, bookingId, error: message };
    }
  }

  private async loadBooking(bookingId: string) {
    // Prefer Prisma, but fall back to REST if it's unavailable OR the query fails
    // at runtime (e.g. a cold cron invocation where the DB connection errors).
    if (this.prisma.isAvailable()) {
      try {
        const b = await this.prisma.cleaningBooking.findUnique({
          where: { id: bookingId },
          include: bookingCalendarInclude,
        });
        if (b) {
          if (!(b as any).slot && (b as any).slotId) {
            const syn = this.synthesizeSlot((b as any).slotId, (b as any).serviceDurationMinutes);
            if (syn) (b as any).slot = syn;
          }
          return b;
        }
      } catch {
        // fall through to REST
      }
    }
    return this.loadBookingViaRest(bookingId);
  }

  private async loadBookingViaRest(bookingId: string) {
    // Fetch the booking plainly (no embeds — some relations lack a detectable FK
    // and would error the whole query), then enrich relations best-effort. Owned
    // bookings have a synthetic slot id, so derive the time from it.
    {
      try {
        const rows = await this.supabaseRest<any[]>(
          `/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`,
        );
        if (!rows?.length) return null;
        const r = rows[0];

        let slot = this.synthesizeSlot(r.slot_id, r.service_duration_minutes);
        if (!slot && r.slot_id) {
          const s = await this.supabaseRest<any[]>(
            `/cleaning_available_slots?id=eq.${encodeURIComponent(r.slot_id)}&select=date,start_time,end_time&limit=1`,
          ).catch(() => []);
          if (s?.length) slot = { date: s[0].date, startTime: s[0].start_time, endTime: s[0].end_time };
        }

        let client: any = null;
        if (r.client_id) {
          const c = await this.supabaseRest<any[]>(
            `/cleaning_clients?id=eq.${encodeURIComponent(r.client_id)}&select=company_name,location&limit=1`,
          ).catch(() => []);
          if (c?.length) client = { companyName: c[0].company_name, location: c[0].location };
        }

        let subscription: any = null;
        const subId = r.cleaning_subscription_id || r.subscription_id;
        if (subId) {
          const sub = await this.supabaseRest<any[]>(
            `/cleaning_subscriptions?id=eq.${encodeURIComponent(subId)}&select=apartment_note,package_id&limit=1`,
          ).catch(() => []);
          if (sub?.length) {
            let pkg: any = null;
            if (sub[0].package_id) {
              const p = await this.supabaseRest<any[]>(
                `/cleaning_packages?id=eq.${encodeURIComponent(sub[0].package_id)}&select=name&limit=1`,
              ).catch(() => []);
              if (p?.length) pkg = { name: p[0].name };
            }
            subscription = { apartmentNote: sub[0].apartment_note ?? null, package: pkg, user: null };
          }
        }

        return {
          ...r,
          id: r.id,
          status: r.status,
          googleCalendarEventId: r.google_calendar_event_id ?? null,
          googleCalendarEventLink: r.google_calendar_event_link ?? null,
          location: r.location ?? null,
          notes: r.notes ?? null,
          assignedCleaner: r.assigned_cleaner ?? null,
          serviceDurationMinutes: r.service_duration_minutes ?? null,
          slot,
          client,
          customPlan: null,
          subscription,
          user: null,
          checklistTemplate: null,
          completionReport: null,
          recurringSchedule: null,
        } as any;
      } catch {
        return null;
      }
    }
  }

  /** Reconstruct a slot {date,startTime,endTime} from an owned-cleaning synthetic id. */
  private synthesizeSlot(slotId?: string | null, durationMinutes?: number | null) {
    const m = /^owned-cleaning-slot-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/.exec(slotId || "");
    if (!m) return null;
    const [, date, hh, mm] = m;
    const startMins = Number(hh) * 60 + Number(mm);
    const endMins = startMins + (Number(durationMinutes) > 0 ? Number(durationMinutes) : 105);
    const fmt = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
    return { date, startTime: fmt(startMins), endTime: fmt(endMins) };
  }

  /** True when another (non-cancelled) booking already points at this calendar event. */
  private async eventIdTakenByOtherBooking(eventId: string, bookingId: string): Promise<boolean> {
    try {
      const rows = await this.supabaseRest<Array<{ id: string }>>(
        `/cleaning_bookings?select=id&google_calendar_event_id=eq.${encodeURIComponent(eventId)}` +
        `&id=neq.${encodeURIComponent(bookingId)}&status=neq.cancelled&limit=1`,
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      // On lookup error, favour uniqueness: treat as taken so we create a fresh event.
      return true;
    }
  }

  private supabaseRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!base || !key) throw new Error("Supabase REST not configured");
    return fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || `Supabase ${res.status}`);
      return body as T;
    });
  }

  private buildEventPayload(booking: BookingWithCalendarRelations): GoogleCalendarEventPayload {
    const clientName = this.clientName(booking);
    const building = this.buildingName(booking);
    const unit = this.apartmentUnit(booking);
    const titleBase = unit ? `Cleaning - ${building} Apt ${unit}` : `Cleaning - ${clientName}`;
    const isCancelled = booking.status === "CANCELLED";

    // Slot times are stored as local Honduras time strings (e.g. "10:00:00").
    // Build the Date with explicit Honduras offset (-06:00, no DST) so that
    // the Google Calendar helper formats the correct wall-clock time.
    const hnOffset = "-06:00";
    const startTime = booking.slot.startTime.slice(0, 5);
    const endTime = booking.slot.endTime.slice(0, 5);

    return {
      summary: isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
      location: unit ? `${building}, Apt ${unit}` : building,
      description: this.description(booking, clientName),
      start: new Date(`${booking.slot.date}T${startTime}:00${hnOffset}`),
      end: new Date(`${booking.slot.date}T${endTime}:00${hnOffset}`),
      colorId: isCancelled ? "11" : undefined,
      // Idempotency key — stored in extendedProperties.private
      bookingId: booking.id,
    };
  }

  private description(booking: BookingWithCalendarRelations, clientName: string) {
    const planName = booking.customPlan?.planName || booking.subscription?.package?.name || "Cleaning booking";
    const checklist = booking.checklistTemplate?.items?.length
      ? `Checklist:\n${booking.checklistTemplate.items.map((item) => `- ${item}`).join("\n")}`
      : null;

    return [
      `Status: ${this.statusLabel(booking.status)}`,
      `Client: ${clientName}`,
      `Plan: ${planName}`,
      booking.assignedCleaner ? `Assigned cleaner: ${booking.assignedCleaner}` : null,
      booking.serviceDurationMinutes ? `Duration: ${booking.serviceDurationMinutes} minutes` : null,
      booking.notes ? `Notes: ${booking.notes}` : null,
      booking.completionReport ? `Completed by: ${booking.completionReport.completedBy}` : null,
      checklist,
      `Booking ID: ${booking.id}`,
    ].filter(Boolean).join("\n");
  }

  private clientName(booking: BookingWithCalendarRelations) {
    return (
      booking.client?.companyName ||
      booking.subscription?.user?.displayName ||
      booking.subscription?.user?.name ||
      booking.user?.displayName ||
      booking.user?.name ||
      booking.subscription?.user?.email ||
      booking.user?.email ||
      "Cleaning client"
    );
  }

  private buildingName(booking: BookingWithCalendarRelations) {
    return booking.location || booking.client?.location || "Prospera Village";
  }

  private apartmentUnit(booking: BookingWithCalendarRelations) {
    const note = booking.subscription?.apartmentNote?.trim() || booking.notes?.trim();
    if (!note) return "";
    const explicitUnit = note.match(/(?:apt|apartment|unit|#)\s*([A-Za-z0-9-]+)/i)?.[1]?.trim();
    if (explicitUnit) return explicitUnit;
    const normalized = note.replace(/^(apt|apartment|unit|#)\s*/i, "").trim();
    return normalized.length <= 24 ? normalized : "";
  }

  private statusLabel(status: CleaningBooking["status"]) {
    return String(status).toLowerCase();
  }

  private async markSyncFailed(bookingId: string, message: string) {
    try {
      if (!this.prisma.isAvailable()) {
        await this.supabaseRest(`/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}`, {
          method: "PATCH",
          body: JSON.stringify({ google_calendar_sync_status: "failed", google_calendar_sync_error: message.slice(0, 1000) }),
        });
        return;
      }
      await this.prisma.cleaningBooking.update({
        where: { id: bookingId },
        data: { googleCalendarSyncStatus: "failed", googleCalendarSyncError: message.slice(0, 1000) },
      });
    } catch (e) {
      this.logger.warn(`markSyncFailed for ${bookingId} failed: ${(e as Error).message}`);
    }
  }
}
