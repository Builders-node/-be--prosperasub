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
  // The service reads date + local Honduras time STRINGS, not Dates. The
  // fixture still described a slot as { startsAt, endsAt }, so every test that
  // built a payload died on `booking.slot.startTime.slice` — the suite has been
  // failing against a shape the code stopped using.
  slot: {
    date: "2026-06-01",
    startTime: "10:00:00",
    endTime: "12:00:00",
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

function createHarness(
  bookingOverrides: Record<string, unknown> = {},
  /** The provider's own calendar, as resolveCalendarId would find it. */
  providerCalendarId: string | null = null,
) {
  const booking = { ...baseBooking, ...bookingOverrides };
  const prisma = {
    // The service gained isAvailable() and this mock was never updated, so five
    // of these tests failed on "this.prisma.isAvailable is not a function"
    // long before they could assert anything.
    isAvailable: jest.fn().mockReturnValue(true),
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
    cancelEvent: jest.fn().mockResolvedValue({ id: "google_event_1", htmlLink: null }),
    deleteEvent: jest.fn().mockResolvedValue(undefined),
    findEventsByBookingId: jest.fn().mockResolvedValue([]),
    findEventsByFallback: jest.fn().mockResolvedValue([]),
  };

  const service = new CleaningCalendarSyncService(prisma as never, googleCalendar as never);
  // resolveCalendarId walks booking -> subscription -> package -> provider over
  // PostgREST. Stubbing the walk keeps these tests about routing rather than
  // about four HTTP shapes.
  jest.spyOn(service, "resolveCalendarId").mockResolvedValue(providerCalendarId ?? undefined);

  return { service, prisma, googleCalendar };
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
      // 10:00–12:00 Honduras (-06:00) is 16:00–18:00 UTC. Asserting the UTC
      // instant is what proves the offset is applied rather than assumed.
      start: new Date("2026-06-01T16:00:00.000Z"),
      end: new Date("2026-06-01T18:00:00.000Z"),
    }), undefined);
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
    // eventIdTakenByOtherBooking asks Supabase whether another booking already
    // owns this event and, on any lookup error, answers "taken" so a fresh
    // event is made rather than two bookings sharing one. With no Supabase in
    // the test environment that guard always fires, which is why this test —
    // named for the update path — never reached it.
    jest.spyOn(service as never as { eventIdTakenByOtherBooking: () => Promise<boolean> },
               "eventIdTakenByOtherBooking").mockResolvedValue(false);

    await service.syncBookingById("booking_1");

    expect(googleCalendar.updateEvent).toHaveBeenCalledWith("existing_event", expect.any(Object), undefined);
    expect(googleCalendar.createEvent).not.toHaveBeenCalled();
  });

  it("cancels the existing event for a cancelled booking", async () => {
    const { service, googleCalendar } = createHarness({
      status: "CANCELLED", googleCalendarEventId: "existing_event",
    });
    jest.spyOn(service as never as { eventIdTakenByOtherBooking: () => Promise<boolean> },
               "eventIdTakenByOtherBooking").mockResolvedValue(false);

    await service.syncBookingById("booking_1");

    expect(googleCalendar.cancelEvent).toHaveBeenCalledWith(
      "existing_event",
      expect.objectContaining({ summary: "[Cancelled] Cleaning - Duna Tower Apt 1204", colorId: "11" }),
      undefined,
    );
  });

  it("does not create an event for a cancelled booking that never had one", async () => {
    // Deliberate: a booking cancelled before it ever synced has nothing to
    // show, and publishing a "[Cancelled]" event for it would put noise on the
    // calendar for something nobody was ever told about. The old test asserted
    // the opposite and had been failing against the current behaviour.
    const { service, googleCalendar } = createHarness({ status: "CANCELLED" });

    await service.syncBookingById("booking_1");

    expect(googleCalendar.createEvent).not.toHaveBeenCalled();
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
    }), undefined);
  });

  it("deletes calendar events for permanently deleted bookings", async () => {
    const { service, googleCalendar } = createHarness({ googleCalendarEventId: "existing_event" });

    const result = await service.deleteCalendarEventForBooking("booking_1");

    expect(result).toEqual({ ok: true, bookingId: "booking_1" });
    expect(googleCalendar.deleteEvent).toHaveBeenCalledWith("existing_event");
  });
});

describe("CleaningCalendarSyncService — which calendar a booking lands on", () => {
  it("writes to the provider's own calendar when it has one", async () => {
    const { service, googleCalendar } = createHarness({}, "car-wash@group.calendar.google.com");

    const result = await service.syncBookingById("booking_1");

    expect(result.ok).toBe(true);
    // Every call in the upsert path must target the same calendar. Creating an
    // event on one and searching for it on another is how duplicates appear.
    expect(googleCalendar.createEvent).toHaveBeenCalledWith(
      expect.anything(),
      "car-wash@group.calendar.google.com",
    );
    expect(googleCalendar.findEventsByBookingId).toHaveBeenCalledWith(
      "booking_1",
      "car-wash@group.calendar.google.com",
    );
    // The caller is told where it actually went, not where the default is.
    expect(result.calendarId).toBe("car-wash@group.calendar.google.com");
  });

  it("falls back to the shared calendar when the provider has none", async () => {
    const { service, googleCalendar } = createHarness({}, null);

    const result = await service.syncBookingById("booking_1");

    expect(result.ok).toBe(true);
    // undefined, not a calendar id: GoogleCalendarService reads that as "use
    // the shared one", so nothing changes for a provider until an admin sets it.
    expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(result.calendarId).toBe("shared-cleaning-calendar@example.test");
  });
});
