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

      const result = await this.upsertCalendarEvent(bookingId, storedEventId, payload, isCancelled);

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
      return { ok: true, bookingId, eventId: result.id, action: result.action, calendarId: this.getSharedAdminCalendarId() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed";
      this.logger.warn(`[sync] Booking ${bookingId} failed: ${message}`);
      await this.markSyncFailed(bookingId, message);
      return { ok: false, bookingId, calendarId: this.getSharedAdminCalendarId(), error: message };
    }
  }

  // ─── Idempotent upsert ────────────────────────────────────────────────────

  private async upsertCalendarEvent(
    bookingId: string,
    storedEventId: string | null,
    payload: GoogleCalendarEventPayload,
    isCancelled: boolean,
  ): Promise<{ id: string; htmlLink?: string | null; action: "created" | "updated" | "cancelled" }> {

    // 1. Try updating the stored event ID first (fastest path)
    if (storedEventId) {
      try {
        const result = isCancelled
          ? await this.googleCalendar.cancelEvent(storedEventId, payload)
          : await this.googleCalendar.updateEvent(storedEventId, payload);
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
    const byId = await this.googleCalendar.findEventsByBookingId(bookingId);
    if (byId.length > 0) {
      const [keep, ...dupes] = byId;
      // Delete duplicates
      for (const dupe of dupes) {
        this.logger.warn(`[sync] Deleting duplicate event ${dupe.id} for booking ${bookingId}`);
        await this.googleCalendar.deleteEvent(dupe.id).catch(() => {/* best effort */});
      }
      // Update the survivor
      const result = isCancelled
        ? await this.googleCalendar.cancelEvent(keep.id, payload)
        : await this.googleCalendar.updateEvent(keep.id, payload);
      this.logger.log(`[sync] Found & updated event ${keep.id} by bookingId for booking ${bookingId}${dupes.length ? ` (deleted ${dupes.length} duplicate(s))` : ""}`);
      return { ...result, action: isCancelled ? "cancelled" : "updated" };
    }

    // 3. Fallback: search by title + date (handles old events without extendedProperties)
    const titlePrefix = payload.summary.replace(/^\[Cancelled\]\s*/i, "").split(" - ")[0];
    const dateStr = payload.start.toISOString().slice(0, 10);
    const byTitle = await this.googleCalendar.findEventsByFallback(titlePrefix, dateStr);
    const matchByTime = byTitle.find((e) => {
      const eStart = e.start?.dateTime ?? e.start?.date ?? "";
      return eStart.startsWith(dateStr);
    });

    if (matchByTime) {
      this.logger.log(`[sync] Found event ${matchByTime.id} by title fallback for booking ${bookingId}`);
      const result = isCancelled
        ? await this.googleCalendar.cancelEvent(matchByTime.id, payload)
        : await this.googleCalendar.updateEvent(matchByTime.id, payload);
      return { ...result, action: isCancelled ? "cancelled" : "updated" };
    }

    // 4. Truly new — create it
    if (isCancelled) {
      // Don't create new events for already-cancelled bookings with no existing event
      this.logger.log(`[sync] Skipping create for cancelled booking ${bookingId} — no existing event`);
      return { id: storedEventId ?? "", htmlLink: null, action: "cancelled" };
    }

    const result = await this.googleCalendar.createEvent(payload);
    this.logger.log(`[sync] Created new event ${result.id} for booking ${bookingId}`);
    return { ...result, action: "created" };
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
    if (!this.prisma.isAvailable()) {
      // Prisma unavailable — load via Supabase REST
      try {
        const rows = await this.supabaseRest<any[]>(
          `/cleaning_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*,cleaning_available_slots(*),cleaning_clients(*),cleaning_custom_plans(*),cleaning_completion_reports(*),cleaning_subscriptions(*,cleaning_packages(*))&limit=1`,
        );
        if (!rows?.length) return null;
        const r = rows[0];
        // Shape it to match the Prisma include structure the caller expects
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
          slot: r.cleaning_available_slots ? {
            date: r.cleaning_available_slots.date,
            startTime: r.cleaning_available_slots.start_time,
            endTime: r.cleaning_available_slots.end_time,
          } : null,
          client: r.cleaning_clients ? {
            companyName: r.cleaning_clients.company_name,
            location: r.cleaning_clients.location,
          } : null,
          customPlan: r.cleaning_custom_plans ? { planName: r.cleaning_custom_plans.plan_name } : null,
          subscription: r.cleaning_subscriptions ? {
            apartmentNote: r.cleaning_subscriptions.apartment_note ?? null,
            package: r.cleaning_subscriptions.cleaning_packages ? {
              name: r.cleaning_subscriptions.cleaning_packages.name,
            } : null,
            user: null,
          } : null,
          user: null,
          checklistTemplate: null,
          completionReport: null,
          recurringSchedule: null,
        } as any;
      } catch {
        return null;
      }
    }
    return this.prisma.cleaningBooking.findUnique({
      where: { id: bookingId },
      include: bookingCalendarInclude,
    });
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
