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

describe("CleaningCalendarSyncService — finding the provider of a booking", () => {
  /**
   * These drive the PostgREST walk itself, so they stub the HTTP layer rather
   * than `resolveCalendarId`. `rest` maps a path fragment to its reply.
   */
  function restHarness(rest: Record<string, unknown[]>, sharedId: string | null = "shared@example.test") {
    const prisma = { isAvailable: jest.fn().mockReturnValue(true) };
    const googleCalendar = {
      getSharedAdminCleaningCalendarId: jest.fn().mockReturnValue(sharedId),
      hasAuth: jest.fn().mockReturnValue(true),
      isConfigured: jest.fn().mockReturnValue(Boolean(sharedId)),
    };
    const service = new CleaningCalendarSyncService(prisma as never, googleCalendar as never);
    const calls: string[] = [];
    (service as unknown as { supabaseRest: (p: string) => Promise<unknown> }).supabaseRest =
      (path: string) => {
        calls.push(path);
        const hit = Object.keys(rest).find((k) => path.includes(k));
        return Promise.resolve(hit ? rest[hit] : []);
      };
    return { service, calls };
  }

  // The reported shape: an admin books somebody who has no subscription, so
  // the old walk had no starting point and the visit went to the shared
  // calendar instead of the business's own.
  it("uses the booking's own provider_id when there is no subscription", async () => {
    const { service, calls } = restHarness({
      "/cleaning_bookings?id=eq.b1": [{ provider_id: "legacy-prov-1", subscription_id: null }],
      "/providers?source_service_key=eq.cleaning": [{ google_calendar_id: "apartments@group.calendar.google.com" }],
    });

    await expect(service.resolveCalendarId("b1")).resolves.toBe("apartments@group.calendar.google.com");
    // It must not have gone looking for a subscription it does not have.
    expect(calls.some((c) => c.includes("/cleaning_subscriptions"))).toBe(false);
  });

  it("still walks the subscription for an older row with no provider_id", async () => {
    const { service, calls } = restHarness({
      "/cleaning_bookings?id=eq.b2": [{ provider_id: null, subscription_id: "sub-1" }],
      "/cleaning_subscriptions?id=eq.sub-1": [{ package_id: "pkg-1" }],
      "/cleaning_packages?id=eq.pkg-1": [{ provider_id: "legacy-prov-2" }],
      "/providers?source_service_key=eq.cleaning": [{ google_calendar_id: "cowork@group.calendar.google.com" }],
    });

    await expect(service.resolveCalendarId("b2")).resolves.toBe("cowork@group.calendar.google.com");
    expect(calls.some((c) => c.includes("/cleaning_subscriptions"))).toBe(true);
  });

  it("returns undefined — the shared calendar — when the provider has none", async () => {
    const { service } = restHarness({
      "/cleaning_bookings?id=eq.b3": [{ provider_id: "legacy-prov-3", subscription_id: null }],
      "/providers?source_service_key=eq.cleaning": [{ google_calendar_id: null }],
    });

    await expect(service.resolveCalendarId("b3")).resolves.toBeUndefined();
  });

  // The month-long outage: the sweep required the SHARED calendar id, so with
  // it unset nothing synced and nothing was even marked failed.
  it("sweeps pending bookings with credentials alone, no shared calendar", async () => {
    const { service } = restHarness({ "/cleaning_bookings?select=id": [{ id: "b9" }] }, null);
    jest.spyOn(service, "syncBookingById").mockResolvedValue({ ok: true, bookingId: "b9" } as never);

    const res = await service.syncPendingBookings();

    expect(res).toMatchObject({ ok: true, processed: 1, synced: 1 });
    expect(service.syncBookingById).toHaveBeenCalledWith("b9");
  });

  it("does nothing without credentials", async () => {
    const prisma = { isAvailable: jest.fn().mockReturnValue(true) };
    const googleCalendar = {
      getSharedAdminCleaningCalendarId: jest.fn().mockReturnValue("shared@example.test"),
      hasAuth: jest.fn().mockReturnValue(false),
      isConfigured: jest.fn().mockReturnValue(false),
    };
    const service = new CleaningCalendarSyncService(prisma as never, googleCalendar as never);

    await expect(service.syncPendingBookings()).resolves.toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("CleaningCalendarSyncService — storing the result when Prisma cannot", () => {
  /**
   * The month-long outage. Prisma's model for cleaning_bookings declares three
   * columns the database does not have, so every Prisma query on that table
   * fails. The READ already fell back to PostgREST; the WRITE did not, so each
   * sync created the Google event and then died before storing its id — the
   * row stayed `pending`, the next run wrote the event again, and a booking
   * later cancelled had no event id to remove by. Hence a calendar still
   * showing visits that no longer exist.
   */
  function harnessWithBrokenPrismaWrite() {
    const booking = { ...baseBooking };
    const prisma = {
      isAvailable: jest.fn().mockReturnValue(true),
      cleaningBooking: {
        findUnique: jest.fn().mockResolvedValue(booking),
        update: jest.fn().mockRejectedValue(
          new Error("The column `cleaning_bookings.custom_plan_id` does not exist in the current database."),
        ),
        delete: jest.fn(),
      },
    };
    const googleCalendar = {
      getSharedAdminCleaningCalendarId: jest.fn().mockReturnValue("shared@example.test"),
      hasAuth: jest.fn().mockReturnValue(true),
      isConfigured: jest.fn().mockReturnValue(true),
      createEvent: jest.fn().mockResolvedValue({ id: "google_event_9", htmlLink: "https://cal/9" }),
      updateEvent: jest.fn(),
      cancelEvent: jest.fn(),
      deleteEvent: jest.fn(),
      findEventsByBookingId: jest.fn().mockResolvedValue([]),
      findEventsByFallback: jest.fn().mockResolvedValue([]),
    };
    const service = new CleaningCalendarSyncService(prisma as never, googleCalendar as never);
    jest.spyOn(service, "resolveCalendarId").mockResolvedValue(undefined);
    const patches: Array<{ path: string; body: unknown }> = [];
    (service as unknown as { supabaseRest: (p: string, i?: RequestInit) => Promise<unknown> }).supabaseRest =
      (path: string, init?: RequestInit) => {
        if (init?.method === "PATCH") patches.push({ path, body: JSON.parse(String(init.body)) });
        return Promise.resolve([]);
      };
    return { service, prisma, patches };
  }

  it("falls back to REST and still records the event id", async () => {
    const { service, prisma, patches } = harnessWithBrokenPrismaWrite();

    const result = await service.syncBookingById("booking_1");

    expect(result.ok).toBe(true);
    expect(prisma.cleaningBooking.update).toHaveBeenCalled();
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toContain("booking_1");
    // Without this the booking never learns which Google event is its own.
    expect(patches[0].body).toMatchObject({
      google_calendar_event_id: "google_event_9",
      google_calendar_sync_status: "synced",
      google_calendar_sync_error: null,
    });
  });

  it("records a failure through REST too, so it is never silent", async () => {
    const { service, patches } = harnessWithBrokenPrismaWrite();
    jest.spyOn(service as never as { upsertCalendarEvent: unknown }, "upsertCalendarEvent" as never)
      .mockRejectedValue(new Error("Google said no") as never);

    const result = await service.syncBookingById("booking_1");

    expect(result.ok).toBe(false);
    expect(patches[0].body).toMatchObject({
      google_calendar_sync_status: "failed",
      google_calendar_sync_error: "Google said no",
    });
  });
});
