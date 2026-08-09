import { BookingService } from "./booking.service";
import { normalizeSchedule } from "./schedule";

/**
 * A beach court's opening hours must be the ones the operator set.
 *
 * `loadEffectiveBookingSettings` only ever read `beach_club_courts.
 * booking_settings`, which is null for every court in production. So the engine
 * fell through to the provider default and published 06:00–18:00 for courts
 * configured 08:00–19:00 — bookable hours nobody set, and none in the evening
 * they did. Neither the type checker nor a build can see that; only asking the
 * generator what it produces can.
 */
describe("beach court hours", () => {
  const build = (court: unknown) =>
    (BookingService.prototype as never as {
      buildFromCourtHours(c: unknown): unknown;
    }).buildFromCourtHours.call({}, court);

  it("uses the court's own open/close hours", () => {
    const schedule = normalizeSchedule(build({ open_hour: 8, close_hour: 19, slot_minutes: 60 }));
    expect(schedule.weekly[0]).toMatchObject({ enabled: true, from: "08:00", to: "19:00" });
    expect(schedule.sessionDurationMin).toBe(60);
  });

  it("opens every day, weekends included", () => {
    // The provider default disables Saturday and Sunday. A beach club that
    // closes at the weekend would be an odd beach club.
    const schedule = normalizeSchedule(build({ open_hour: 8, close_hour: 19, slot_minutes: 60 }));
    expect(schedule.weekly.filter((d) => d.enabled)).toHaveLength(7);
  });

  it("honours a non-hourly slot length", () => {
    const schedule = normalizeSchedule(build({ open_hour: 9, close_hour: 12, slot_minutes: 90 }));
    expect(schedule.sessionDurationMin).toBe(90);
    expect(schedule.weekly[0]).toMatchObject({ from: "09:00", to: "12:00" });
  });

  it("falls back rather than inventing hours from bad data", () => {
    // null → the provider default is the right answer; a court with close <=
    // open would otherwise generate an empty or inverted day.
    expect(build(undefined)).toBeNull();
    expect(build({ open_hour: null, close_hour: null, slot_minutes: null })).toBeNull();
    expect(build({ open_hour: 19, close_hour: 8, slot_minutes: 60 })).toBeNull();
    expect(build({ open_hour: 10, close_hour: 10, slot_minutes: 60 })).toBeNull();
  });

  it("defaults the slot length when the court doesn't set one", () => {
    const schedule = normalizeSchedule(build({ open_hour: 8, close_hour: 19, slot_minutes: null }));
    expect(schedule.sessionDurationMin).toBe(60);
  });
});
