import { bookedHours, hourAllowanceFor, periodWindow } from "./allowance";

const COURT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
/** Honduras: UTC-6 all year. */
const HN = -360;

const hourLine = (quantity: number | null, period: string | null = null, resources: string[] = []) => ({
  unit: "hour", quantity, period, resource_ids: resources,
});

describe("hourAllowanceFor", () => {
  it("is unlimited when no plan counts hours", () => {
    expect(hourAllowanceFor([{ id: "p1", entitlements: [{ unit: "access", quantity: null }] }], COURT)).toBeNull();
    expect(hourAllowanceFor([], COURT)).toBeNull();
    expect(hourAllowanceFor(null, COURT)).toBeNull();
  });

  it("reads the limit and inherits the plan's period", () => {
    expect(hourAllowanceFor([{ id: "p1", period: "monthly", entitlements: [hourLine(4)] }], COURT))
      .toEqual({ limit: 4, period: "monthly" });
  });

  it("prefers the line's own period over the plan's", () => {
    expect(hourAllowanceFor([{ id: "p1", period: "monthly", entitlements: [hourLine(4, "weekly")] }], COURT))
      .toEqual({ limit: 4, period: "weekly" });
  });

  it("ignores a line that names other calendars", () => {
    expect(hourAllowanceFor([{ id: "p1", entitlements: [hourLine(4, "weekly", [OTHER])] }], COURT)).toBeNull();
    expect(hourAllowanceFor([{ id: "p1", entitlements: [hourLine(4, "weekly", [COURT])] }], COURT))
      .toEqual({ limit: 4, period: "weekly" });
  });

  it("treats a missing or zero quantity as unlimited", () => {
    expect(hourAllowanceFor([{ id: "p1", entitlements: [hourLine(null, "weekly")] }], COURT)).toBeNull();
    expect(hourAllowanceFor([{ id: "p1", entitlements: [hourLine(0, "weekly")] }], COURT)).toBeNull();
  });

  it("adds up distinct plans and counts the same plan once", () => {
    const four = { id: "p1", entitlements: [hourLine(4, "weekly")] };
    const two = { id: "p2", entitlements: [hourLine(2, "weekly")] };
    expect(hourAllowanceFor([four, two], COURT)).toEqual({ limit: 6, period: "weekly" });
    // Two subscriptions to the same plan are not twice the allowance.
    expect(hourAllowanceFor([four, { ...four }], COURT)).toEqual({ limit: 4, period: "weekly" });
  });

  it("lets an unlimited plan win over a capped one", () => {
    expect(hourAllowanceFor(
      [{ id: "p1", entitlements: [hourLine(4, "weekly")] }, { id: "p2", entitlements: [hourLine(null)] }],
      COURT,
    )).toBeNull();
  });

  it("resolves disagreeing periods to the shortest cycle", () => {
    expect(hourAllowanceFor(
      [{ id: "p1", entitlements: [hourLine(10, "monthly")] }, { id: "p2", entitlements: [hourLine(4, "weekly")] }],
      COURT,
    )).toEqual({ limit: 14, period: "weekly" });
  });
});

describe("periodWindow", () => {
  it("starts a week on the local Monday", () => {
    // Wednesday 2026-08-19, 03:00 UTC → 2026-08-18 21:00 in Honduras (Tuesday).
    const { start, end } = periodWindow("weekly", new Date("2026-08-19T03:00:00Z"), HN);
    expect(start.toISOString()).toBe("2026-08-17T06:00:00.000Z"); // Mon 00:00 HN
    expect(end.toISOString()).toBe("2026-08-24T06:00:00.000Z");
  });

  it("uses the local month, not the UTC one", () => {
    // 2026-09-01 03:00 UTC is still 31 August in Honduras.
    const { start, end } = periodWindow("monthly", new Date("2026-09-01T03:00:00Z"), HN);
    expect(start.toISOString()).toBe("2026-08-01T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-01T06:00:00.000Z");
  });

  it("brackets the quarter and the year", () => {
    expect(periodWindow("quarterly", new Date("2026-08-19T12:00:00Z"), HN).start.toISOString())
      .toBe("2026-07-01T06:00:00.000Z");
    expect(periodWindow("yearly", new Date("2026-08-19T12:00:00Z"), HN).start.toISOString())
      .toBe("2026-01-01T06:00:00.000Z");
  });
});

describe("bookedHours", () => {
  it("counts duration, not bookings", () => {
    expect(bookedHours([
      { startAt: "2026-08-18T14:00:00Z", endAt: "2026-08-18T15:00:00Z" },
      { startAt: "2026-08-19T14:00:00Z", endAt: "2026-08-19T15:30:00Z" },
    ])).toBe(2.5);
  });

  it("treats a span with no end as one hour", () => {
    expect(bookedHours([{ startAt: "2026-08-18T14:00:00Z", endAt: null }])).toBe(1);
  });

  it("is zero for nothing", () => {
    expect(bookedHours([])).toBe(0);
    expect(bookedHours(null)).toBe(0);
  });
});
