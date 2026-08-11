import { normalizeSchedule, blockAppliesOn, DEFAULT_SCHEDULE } from "./schedule";
import { generateSlots } from "./slot-engine";

/**
 * A blocked time range with no date repeats every day.
 *
 * Until it could be expressed, the only way to say "never 12:00–13:00" was to
 * add the same range once per date, forever — so nobody did, and lunch hours
 * were simply bookable. The rule lives in two engines (this one and the
 * frontend's computeSlots) and both must read a missing date the same way;
 * a disagreement means the customer is offered an hour the provider closed.
 */
describe("blocked ranges without a date", () => {
  const scheduleWith = (ranges: unknown[]) =>
    normalizeSchedule({
      ...DEFAULT_SCHEDULE,
      weekly: DEFAULT_SCHEDULE.weekly.map(() => ({ enabled: true, from: "09:00", to: "17:00" })),
      sessionDurationMin: 60,
      blockedRanges: ranges,
    });

  // 2026-08-12 is a Wednesday, 2026-08-13 a Thursday.
  const WED = "2026-08-12";
  const THU = "2026-08-13";

  const slotsOn = (ranges: unknown[], date: string) =>
    generateSlots("time_slot", scheduleWith(ranges), date).map((s) => s.from);

  it("applies on every day when the date is null", () => {
    const ranges = [{ date: null, from: "12:00", to: "13:00" }];
    expect(slotsOn(ranges, WED)).not.toContain("12:00");
    expect(slotsOn(ranges, THU)).not.toContain("12:00");
  });

  it("still leaves the rest of the day bookable", () => {
    const slots = slotsOn([{ date: null, from: "12:00", to: "13:00" }], WED);
    expect(slots).toContain("11:00");
    expect(slots).toContain("13:00");
  });

  it("applies only to its own day when a date is given", () => {
    const ranges = [{ date: WED, from: "12:00", to: "13:00" }];
    expect(slotsOn(ranges, WED)).not.toContain("12:00");
    expect(slotsOn(ranges, THU)).toContain("12:00");
  });

  it("reads an empty date as every day, not as no day", () => {
    // "" is what the old editor wrote when no date was picked. It matched
    // nothing, so the block the provider added silently did nothing at all.
    const ranges = [{ date: "", from: "12:00", to: "13:00" }];
    expect(normalizeSchedule({ ...DEFAULT_SCHEDULE, blockedRanges: ranges }).blockedRanges[0].date).toBeNull();
    expect(slotsOn(ranges, WED)).not.toContain("12:00");
  });

  it("keeps a range whose date is missing entirely", () => {
    const schedule = normalizeSchedule({ ...DEFAULT_SCHEDULE, blockedRanges: [{ from: "12:00", to: "13:00" }] });
    expect(schedule.blockedRanges).toHaveLength(1);
    expect(schedule.blockedRanges[0].date).toBeNull();
  });

  it("drops a range with no times — there is nothing to block", () => {
    const schedule = normalizeSchedule({ ...DEFAULT_SCHEDULE, blockedRanges: [{ date: WED }] });
    expect(schedule.blockedRanges).toHaveLength(0);
  });

  // ── No buffer in front of a block ────────────────────────────────────────
  // The buffer is the gap after a JOB — tidying up, driving on. A blocked hour
  // is not a job, so the day resumes the moment the block ends. Stepping the
  // fixed grid past it instead pushed the first slot after a 12:00–15:00 lunch
  // to 15:30 and silently cost half an hour of every such day.
  describe("the day resumes when the block ends", () => {
    const withBuffer = (ranges: unknown[]) =>
      normalizeSchedule({
        ...DEFAULT_SCHEDULE,
        weekly: DEFAULT_SCHEDULE.weekly.map(() => ({ enabled: true, from: "08:00", to: "18:00" })),
        sessionDurationMin: 60,
        bufferAfterMin: 30,
        blockedRanges: ranges,
      });
    const at = (ranges: unknown[]) =>
      generateSlots("time_slot", withBuffer(ranges), WED).map((s) => `${s.from}-${s.to}`);

    it("starts the next slot exactly at the block's end", () => {
      const slots = at([{ date: null, from: "12:00", to: "15:00" }]);
      expect(slots).toContain("15:00-16:00");
      expect(slots).not.toContain("15:30-16:30");
    });

    it("keeps the grid stepping normally after it resumes", () => {
      const slots = at([{ date: null, from: "12:00", to: "15:00" }]);
      // 15:00 + (60 + 30) = 16:30
      expect(slots).toContain("16:30-17:30");
    });

    it("leaves everything before the block untouched", () => {
      const slots = at([{ date: null, from: "12:00", to: "15:00" }]);
      expect(slots.slice(0, 3)).toEqual(["08:00-09:00", "09:30-10:30", "11:00-12:00"]);
    });

    it("resumes past the LAST of several overlapping blocks", () => {
      const slots = at([
        { date: null, from: "12:00", to: "13:00" },
        { date: null, from: "12:30", to: "14:00" },
      ]);
      expect(slots).toContain("14:00-15:00");
      expect(slots.some((s) => s.startsWith("12:") || s.startsWith("13:"))).toBe(false);
    });

    it("terminates when a block ends at or before it starts", () => {
      // A zero-width or inverted range must not stall the loop. If this ever
      // regresses the test suite hangs rather than fails, so it is worth having.
      const slots = at([{ date: null, from: "12:00", to: "12:00" }]);
      expect(slots.length).toBeGreaterThan(0);
    });
  });

  it("blockAppliesOn matches the filter both engines use", () => {
    expect(blockAppliesOn({ date: null, from: "12:00", to: "13:00" }, WED)).toBe(true);
    expect(blockAppliesOn({ date: WED, from: "12:00", to: "13:00" }, WED)).toBe(true);
    expect(blockAppliesOn({ date: WED, from: "12:00", to: "13:00" }, THU)).toBe(false);
  });
});
