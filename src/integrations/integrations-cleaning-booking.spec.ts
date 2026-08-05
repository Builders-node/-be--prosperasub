import { BadRequestException } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";

/**
 * Contract for `POST /integrations/builders-node/cleaning-booking`.
 *
 * Two things a partner integration depends on and neither the type checker nor
 * a build can catch:
 *
 *  1. A time the partner made up must be REJECTED. This endpoint used to seed a
 *     slot for whatever time it was handed and return a `warning` the caller
 *     was free to ignore — which is how a visit could land at an hour no
 *     cleaner works. The published grid is the schedule.
 *
 *  2. The visit must reach the cleaners' Google Calendar during the call. It
 *     used to be flagged `pending` and left to a daily cron, so for up to 24h
 *     the booking existed but nobody had been told to show up. And a calendar
 *     failure must NOT fail the request — the booking is already committed, and
 *     reporting failure invites the partner to retry and double-book.
 */

const SLOT = {
  id: "slot-2099-01-05-0800",
  date: "2099-01-05",
  start_time: "08:00:00",
  end_time: "10:00:00",
  current_bookings: 0,
  max_bookings: 3,
  is_active: true,
};

function buildService(opts: { calendarResult?: unknown; calendarThrows?: boolean } = {}) {
  const calendarSync = {
    isConfigured: () => true,
    syncBookingById: jest.fn(async () => {
      if (opts.calendarThrows) throw new Error("Google rejected the credentials");
      return opts.calendarResult ?? { ok: true, bookingId: "b1", eventId: "evt-1" };
    }),
  };

  const service = new IntegrationsService(
    { get: (k: string) => (k === "SUPABASE_URL" ? "https://x.supabase.co" : "service-role-key") } as never,
    {} as never,
    calendarSync as never,
  );

  const patched: Array<{ path: string; body: unknown }> = [];
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];

  // Stand in for PostgREST. Routed by the query string the service builds, so
  // the real query-building code is still what's under test.
  (service as never as Record<string, unknown>).rest = async (path: string) => {
    if (path.startsWith("users?")) return [{ id: "user-1" }];
    if (path.startsWith("cleaning_subscriptions?")) {
      return [{ id: "sub-1", user_id: "user-1", package_id: "pkg-1", apartment_note: "Apt 1204" }];
    }
    if (path.startsWith("cleaning_available_slots?")) {
      // Only the exact published time matches — anything else comes back empty,
      // exactly as Postgres would answer. Note the query filters on start_time
      // only; asserting that here is what pins the fix below.
      expect(path).not.toContain("end_time=eq.");
      return path.includes("start_time=eq.08:00:00") ? [SLOT] : [];
    }
    return [];
  };
  (service as never as Record<string, unknown>).insertReturning = async (
    table: string,
    row: Record<string, unknown>,
  ) => {
    inserted.push({ table, row });
    return [{ id: "booking-1", ...row }];
  };
  (service as never as Record<string, unknown>).patch = async (path: string, body: unknown) => {
    patched.push({ path, body });
    return [];
  };
  (service as never as Record<string, unknown>).todayHN = () => "2099-01-01";
  (service as never as Record<string, unknown>).listCleaningSlots = async () => ({
    from: "2099-01-05",
    to: "2099-01-05",
    slots: [{ start_time: "08:00", end_time: "10:00" }],
  });

  return { service, calendarSync, inserted, patched };
}

const BODY = { user_id: "user-1", date: "2099-01-05", start_time: "08:00", end_time: "10:00" } as never;

describe("builders-node cleaning booking", () => {
  it("books a time that is on the published grid", async () => {
    const { service, inserted, patched } = buildService();
    const res = await service.createCleaningBooking(BODY);

    expect(res.status).toBe("booked");
    expect(res.slot_id).toBe(SLOT.id);
    expect(inserted.find((i) => i.table === "cleaning_bookings")).toBeTruthy();
    // Capacity has to move, or the slot stays bookable past its limit.
    expect(patched[0].body).toMatchObject({ current_bookings: 1 });
  });

  it("books when the partner sends no end_time, and returns the slot's real end", async () => {
    // end_time is optional in the DTO. The lookup used to default a missing one
    // to the start time and demand an exact match, which — once a miss became a
    // 400 — would have rejected every request that omitted it.
    const { service } = buildService();
    const res = await service.createCleaningBooking({
      user_id: "user-1", date: "2099-01-05", start_time: "08:00",
    } as never);

    expect(res.status).toBe("booked");
    expect(res.slot_id).toBe(SLOT.id);
    // 10:00 from the published slot — not "08:00", which would describe a visit
    // that ends the moment it starts.
    expect(res.end_time).toBe("10:00");
  });

  it("rejects a time that is not on the published grid, and says which times are", async () => {
    const { service, inserted } = buildService();
    const call = service.createCleaningBooking({ ...(BODY as object), start_time: "09:37" } as never);

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(/09:37/);
    await expect(call).rejects.toThrow(/Available: 08:00/);
    // Nothing may be written for a rejected time — no invented slot, no booking.
    expect(inserted).toHaveLength(0);
  });

  it("puts the visit on the calendar during the call, not on the next cron", async () => {
    const { service, calendarSync } = buildService();
    const res = await service.createCleaningBooking(BODY);

    expect(calendarSync.syncBookingById).toHaveBeenCalledWith("booking-1");
    expect(res.calendar_synced).toBe(true);
    expect(res.calendar_warning).toBeUndefined();
  });

  it("still reports the booking as made when the calendar sync fails", async () => {
    const { service } = buildService({ calendarThrows: true });
    const res = await service.createCleaningBooking(BODY);

    // The row is committed. Telling the partner it failed would invite a retry
    // and a duplicate visit; the cron picks the calendar up either way.
    expect(res.status).toBe("booked");
    expect(res.calendar_synced).toBe(false);
    expect(res.calendar_warning).toMatch(/credentials/);
  });

  it("reports the same when Google Calendar isn't configured at all", async () => {
    const { service } = buildService();
    (service as never as Record<string, unknown>).cleaningCalendarSync = {
      isConfigured: () => false,
      syncBookingById: jest.fn(),
    };
    const res = await service.createCleaningBooking(BODY);

    expect(res.status).toBe("booked");
    expect(res.calendar_synced).toBe(false);
    expect(res.calendar_warning).toMatch(/not configured/);
  });
});
