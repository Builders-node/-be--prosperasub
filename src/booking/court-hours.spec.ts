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

/**
 * A calendar's own hours, whoever authored them.
 *
 * `bookable_resources.hours` was backfilled and then ignored: the only
 * per-resource lookup was the beach-shaped one below, so a room, a table or a
 * chair could not carry opening hours at all. These pin the two shapes the
 * column is written in — and pin that nonsense in it falls through to the
 * provider's default instead of inventing a day.
 */
describe("resource hours", () => {
  const read = (hours: unknown) =>
    (BookingService.prototype as never as {
      scheduleFromResourceHours(h: unknown): unknown;
    }).scheduleFromResourceHours.call(BookingService.prototype, hours);

  it("reads the open/close shape the editor writes", () => {
    const schedule = normalizeSchedule(read({ open_hour: 9, close_hour: 17, slot_minutes: 30 }));
    expect(schedule.weekly[0]).toMatchObject({ enabled: true, from: "09:00", to: "17:00" });
    expect(schedule.sessionDurationMin).toBe(30);
  });

  it("passes a full week through untouched", () => {
    const weekly = Array.from({ length: 7 }, (_, i) => ({
      enabled: i < 5, from: "10:00", to: "14:00",
    }));
    const schedule = normalizeSchedule(read({ weekly, sessionDurationMin: 45 }));
    expect(schedule.weekly.filter((d) => d.enabled)).toHaveLength(5);
    expect(schedule.sessionDurationMin).toBe(45);
  });

  it("declines to answer when there are no hours", () => {
    // null is the signal to fall through to the provider default — returning a
    // schedule here would publish bookable hours nobody set.
    expect(read(null)).toBeNull();
    expect(read({})).toBeNull();
    expect(read({ open_hour: 19, close_hour: 8 })).toBeNull();
  });
});
