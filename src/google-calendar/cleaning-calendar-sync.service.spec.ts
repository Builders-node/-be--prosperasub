import { CleaningCalendarSyncService, buildGoogleCalendarRRule } from "./cleaning-calendar-sync.service";

const baseBooking = {
  id: "booking_1",
  status: "BOOKED",
  notes: "Use service elevator",
  location: "Duna Tower",
  assignedCleaner: null,
  serviceDurationMinutes: 120,
  googleCalendarEventId: null,
  googleCalendarEventLink: null,
  slot: {
    startsAt: new Date("2026-06-01T16:00:00.000Z"),
    endsAt: new Date("2026-06-01T18:00:00.000Z"),
  },
  client: null,
  customPlan: null,
  recurringSchedule: null,
  checklistTemplate: null,
  completionReport: null,
  subscription: {
    apartmentNote: "1204",
    package: { name: "1 Bedroom & Studio" },
    user: {
      email: "client@example.test",
      name: "Client Name",
      displayName: "Client Name",
    },
  },
  user: {
    email: "client@example.test",
    name: "Client Name",
    displayName: "Client Name",
  },
};

function createHarness(bookingOverrides: Record<string, unknown> = {}) {
  const booking = { ...baseBooking, ...bookingOverrides };
  const prisma = {
    cleaningBooking: {
      findUnique: jest.fn().mockResolvedValue(booking),
      update: jest.fn().mockResolvedValue({ ...booking, googleCalendarSyncStatus: "synced" }),
      delete: jest.fn(),
    },
  };
  const googleCalendar = {
    getSharedAdminCleaningCalendarId: jest.fn().mockReturnValue("shared-cleaning-calendar@example.test"),
    createEvent: jest.fn().mockResolvedValue({ id: "google_event_1", htmlLink: "https://calendar.google.com/event?eid=1" }),
    updateEvent: jest.fn().mockResolvedValue({ id: "google_event_1", htmlLink: "https://calendar.google.com/event?eid=1" }),
    deleteEvent: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new CleaningCalendarSyncService(prisma as never, googleCalendar as never),
    prisma,
    googleCalendar,
  };
}

describe("CleaningCalendarSyncService", () => {
  it("builds Google Calendar RRULE strings", () => {
    expect(buildGoogleCalendarRRule("WEEKLY", new Date("2026-08-31T00:00:00.000Z"))).toBe("RRULE:FREQ=WEEKLY;UNTIL=20260831T000000Z");
  });

  it("creates a calendar event for an unsynced booking", async () => {
    const { service, prisma, googleCalendar } = createHarness();

    const result = await service.syncBookingById("booking_1");

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ calendarId: "shared-cleaning-calendar@example.test" });
    expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Cleaning - Duna Tower Apt 1204",
      location: "Duna Tower, Apt 1204",
      start: baseBooking.slot.startsAt,
      end: baseBooking.slot.endsAt,
    }));
    expect(googleCalendar.updateEvent).not.toHaveBeenCalled();
    expect(prisma.cleaningBooking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        googleCalendarEventId: "google_event_1",
        googleCalendarEventLink: "https://calendar.google.com/event?eid=1",
        googleCalendarSyncStatus: "synced",
        googleCalendarSyncError: null,
      }),
    }));
  });

  it("updates an existing calendar event instead of creating a duplicate", async () => {
    const { service, googleCalendar } = createHarness({ googleCalendarEventId: "existing_event" });

    await service.syncBookingById("booking_1");

    expect(googleCalendar.updateEvent).toHaveBeenCalledWith("existing_event", expect.any(Object));
    expect(googleCalendar.createEvent).not.toHaveBeenCalled();
  });

  it("marks cancelled bookings as cancelled calendar events", async () => {
    const { service, googleCalendar } = createHarness({ status: "CANCELLED" });

    await service.syncBookingById("booking_1");

    expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      summary: "[Cancelled] Cleaning - Duna Tower Apt 1204",
      colorId: "11",
    }));
  });

  it("stores sync failures without throwing", async () => {
    const { service, prisma, googleCalendar } = createHarness();
    googleCalendar.createEvent.mockRejectedValueOnce(new Error("Google Calendar request failed"));

    const result = await service.syncBookingById("booking_1");

    expect(result).toEqual({
      ok: false,
      bookingId: "booking_1",
      calendarId: "shared-cleaning-calendar@example.test",
      error: "Google Calendar request failed",
    });
    expect(prisma.cleaningBooking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        googleCalendarSyncStatus: "failed",
        googleCalendarSyncError: "Google Calendar request failed",
      }),
    }));
  });

  it("uses required apartment notes from booking notes when subscription notes are missing", async () => {
    const { service, googleCalendar } = createHarness({
      notes: "Apartment 508. Please call on arrival.",
      subscription: { ...baseBooking.subscription, apartmentNote: "" },
    });

    await service.syncBookingById("booking_1");

    expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Cleaning - Duna Tower Apt 508",
      location: "Duna Tower, Apt 508",
    }));
  });

  it("deletes calendar events for permanently deleted bookings", async () => {
    const { service, googleCalendar } = createHarness({ googleCalendarEventId: "existing_event" });

    const result = await service.deleteCalendarEventForBooking("booking_1");

    expect(result).toEqual({ ok: true, bookingId: "booking_1" });
    expect(googleCalendar.deleteEvent).toHaveBeenCalledWith("existing_event");
  });
});
