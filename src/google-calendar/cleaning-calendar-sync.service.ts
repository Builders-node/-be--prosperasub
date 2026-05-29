import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type CleaningBooking, type CleaningBookingStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { GoogleCalendarService, type GoogleCalendarEventPayload } from "./google-calendar.service";

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
    if (!booking) {
      throw new NotFoundException("Cleaning booking not found");
    }

    try {
      const payload = this.buildEventPayload(booking);
      const result = booking.googleCalendarEventId
        ? await this.googleCalendar.updateEvent(booking.googleCalendarEventId, payload)
        : await this.googleCalendar.createEvent(payload);

      const updatedBooking = await this.prisma.cleaningBooking.update({
        where: { id: bookingId },
        data: {
          googleCalendarEventId: result.id,
          googleCalendarEventLink: result.htmlLink ?? booking.googleCalendarEventLink,
          googleCalendarSyncedAt: new Date(),
          googleCalendarSyncStatus: "synced",
          googleCalendarSyncError: null,
        },
      });

      return { ok: true, bookingId, calendarId: this.getSharedAdminCalendarId(), booking: updatedBooking };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed";
      this.logger.warn(`Cleaning booking ${bookingId} calendar sync failed: ${message}`);
      await this.markSyncFailed(bookingId, message);
      return { ok: false, bookingId, calendarId: this.getSharedAdminCalendarId(), error: message };
    }
  }

  async deleteCalendarEventForBooking(bookingId: string) {
    const booking = await this.prisma.cleaningBooking.findUnique({
      where: { id: bookingId },
      select: { googleCalendarEventId: true },
    });
    if (!booking?.googleCalendarEventId) {
      return { ok: true, bookingId, skipped: true };
    }

    try {
      await this.googleCalendar.deleteEvent(booking.googleCalendarEventId);
      return { ok: true, bookingId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar delete failed";
      await this.markSyncFailed(bookingId, message);
      return { ok: false, bookingId, error: message };
    }
  }

  private async loadBooking(bookingId: string) {
    return this.prisma.cleaningBooking.findUnique({
      where: { id: bookingId },
      include: bookingCalendarInclude,
    });
  }

  private buildEventPayload(booking: BookingWithCalendarRelations): GoogleCalendarEventPayload {
    const clientName = this.clientName(booking);
    const building = this.buildingName(booking);
    const unit = this.apartmentUnit(booking);
    const titleBase = unit ? `Cleaning - ${building} Apt ${unit}` : `Cleaning - ${clientName}`;
    const isCancelled = booking.status === "CANCELLED";

    return {
      summary: isCancelled ? `[Cancelled] ${titleBase}` : titleBase,
      location: unit ? `${building}, Apt ${unit}` : building,
      description: this.description(booking, clientName),
      start: booking.slot.startsAt,
      end: booking.slot.endsAt,
      colorId: isCancelled ? "11" : undefined,
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
      booking.subscription?.user.displayName ||
      booking.subscription?.user.name ||
      booking.user.displayName ||
      booking.user.name ||
      booking.subscription?.user.email ||
      booking.user.email ||
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

  private statusLabel(status: CleaningBookingStatus | CleaningBooking["status"]) {
    return String(status).toLowerCase();
  }

  private async markSyncFailed(bookingId: string, message: string) {
    await this.prisma.cleaningBooking.update({
      where: { id: bookingId },
      data: {
        googleCalendarSyncStatus: "failed",
        googleCalendarSyncError: message.slice(0, 1000),
      },
    });
  }
}
