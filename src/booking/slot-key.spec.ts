import { baseSlotKey } from "./booking.service";

/**
 * The slot-key contract behind capacity seats.
 *
 * A capacity_seat booking claims `resource|date|from|s<n>` so the unique index
 * guards one SEAT; everything that reasons about the slot as a whole — the
 * waitlist above all — must strip the seat back off. If this mapping drifts,
 * a cancelled boat seat stops promoting whoever queued for the departure.
 */
describe("baseSlotKey", () => {
  const base = "3f0e8c1a-0000-0000-0000-000000000000|2026-09-02|09:00";

  it("strips a seat suffix", () => {
    expect(baseSlotKey(`${base}|s1`)).toBe(base);
    expect(baseSlotKey(`${base}|s12`)).toBe(base);
  });

  it("leaves a plain slot key alone", () => {
    expect(baseSlotKey(base)).toBe(base);
  });
});
