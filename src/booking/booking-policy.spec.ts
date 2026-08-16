import { DEFAULT_POLICY, normalizePolicy, normalizeSchedule } from "./schedule";

/**
 * The policy's dangerous direction is "locked", not "open".
 *
 * Every provider on the platform has booking settings written before these
 * fields existed, and most will never open the screen. If an absent or
 * malformed policy read as a restriction, those providers would stop taking
 * bookings the moment this shipped — silently, because a refused hold looks
 * exactly like a full day.
 *
 * So: absent means no restriction, and only a value the provider actually set
 * can turn one on.
 */
describe("booking policy", () => {
  it("treats an absent policy as no restriction", () => {
    expect(normalizePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy({})).toEqual(DEFAULT_POLICY);
  });

  it("keeps settings written before the policy existed open", () => {
    const legacy = normalizeSchedule({
      timezone: "America/Tegucigalpa",
      sessionDurationMin: 60,
      minNoticeHours: 12,
      maxAdvanceDays: 30,
    });
    expect(legacy.policy.requiresMembership).toBe(false);
    expect(legacy.policy.maxActiveBookings).toBe(0);
    expect(legacy.policy.maxPerDay).toBe(0);
    expect(legacy.policy.cancelNoticeHours).toBe(0);
  });

  it("only locks on an explicit true", () => {
    expect(normalizePolicy({ requiresMembership: true }).requiresMembership).toBe(true);
    // Anything else — a string, a 1, a missing key — is not a decision.
    expect(normalizePolicy({ requiresMembership: "yes" }).requiresMembership).toBe(false);
    expect(normalizePolicy({ requiresMembership: 1 }).requiresMembership).toBe(false);
  });

  it("reads a limit only when it is a positive whole number", () => {
    expect(normalizePolicy({ maxPerDay: 2 }).maxPerDay).toBe(2);
    expect(normalizePolicy({ maxPerDay: 2.7 }).maxPerDay).toBe(2);
    // Negatives and nonsense would otherwise become a limit nobody can satisfy.
    expect(normalizePolicy({ maxPerDay: -3 }).maxPerDay).toBe(0);
    expect(normalizePolicy({ maxPerDay: "three" }).maxPerDay).toBe(0);
    expect(normalizePolicy({ maxActiveBookings: 0 }).maxActiveBookings).toBe(0);
  });

  it("keeps the cancel window as given, including fractions of an hour", () => {
    expect(normalizePolicy({ cancelNoticeHours: 1.5 }).cancelNoticeHours).toBe(1.5);
    expect(normalizePolicy({ cancelNoticeHours: -1 }).cancelNoticeHours).toBe(0);
  });
});
