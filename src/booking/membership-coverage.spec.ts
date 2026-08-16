import { BookingService } from "./booking.service";

/**
 * Who a plan lets through the gate.
 *
 * `requiresMembership` refuses people, so the decision is pinned rather than
 * trusted. Three shapes matter and each of them once behaved differently:
 * a plan that names nothing (the ordinary all-access membership, and every
 * plan written before the column existed), a plan that names calendars in its
 * flat column, and a plan that names them inside an entitlement line.
 *
 * The two "don't refuse" cases are the important ones. A member whose plan
 * cannot be resolved to a universal row is a gap in OUR mirroring; turning
 * them away at the door for it would be the worst possible way to report it.
 */
describe("membership coverage", () => {
  const COURT = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const decide = BookingService.decideCoverage;

  it("refuses only when there is no subscription at all", () => {
    expect(decide(COURT, null)).toBe("none");
  });

  it("lets a subscriber through when their plan cannot be resolved", () => {
    expect(decide(COURT, [])).toBe("ok");
  });

  it("treats a plan that names nothing as all-access", () => {
    expect(decide(COURT, [{}])).toBe("ok");
    expect(decide(COURT, [{ resource_ids: [], entitlements: [] }])).toBe("ok");
  });

  it("honours the flat column", () => {
    expect(decide(COURT, [{ resource_ids: [COURT] }])).toBe("ok");
    expect(decide(COURT, [{ resource_ids: [OTHER] }])).toBe("other_resource");
  });

  it("honours calendars named inside an entitlement line", () => {
    const plan = { entitlements: [{ unit: "hour", quantity: 4, resource_ids: [COURT] }] };
    expect(decide(COURT, [plan])).toBe("ok");
    expect(decide(OTHER, [plan])).toBe("other_resource");
  });

  it("takes the widest of several plans", () => {
    // Two memberships, one narrow and one open: holding both means both.
    const narrow = { resource_ids: [OTHER] };
    const open = { resource_ids: [] };
    expect(decide(COURT, [narrow, open])).toBe("ok");
  });

  it("ignores junk in the columns rather than locking the gate on it", () => {
    expect(decide(COURT, [{ resource_ids: "not-an-array", entitlements: 7 }])).toBe("ok");
    expect(decide(COURT, [{ entitlements: [null, { resource_ids: [123] }] }])).toBe("ok");
  });
});
