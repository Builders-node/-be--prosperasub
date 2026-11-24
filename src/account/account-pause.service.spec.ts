import { ConfigService } from "@nestjs/config";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AccountPauseService, addDaysStr, daysBetween, pauseDaysUsed, withoutPause } from "./account-pause.service";

/**
 * A pause moves money-backed time around, so every rule that stops it from
 * becoming free extra days gets a test.
 */

const USER = "11111111-1111-1111-1111-111111111111";
const SUB = "33333333-3333-3333-3333-333333333333";
// Noon UTC on 10 Dec 2026 is 06:00 in Honduras: business day 2026-12-10.
const NOW = new Date("2026-12-10T12:00:00Z");

const config = {
  get: (key: string) =>
    ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-key" } as Record<string, string>)[key],
} as ConfigService;

const notifications = { create: jest.fn(async () => undefined) } as any;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    user_id: USER,
    status: "active",
    payment_status: "paid",
    start_date: "2026-12-01",
    end_date: "2026-12-31",
    auto_renew: false,
    metadata: { plan_name: "Gym" },
    ...overrides,
  };
}

/** A fake PostgREST: GET answers with the row, PATCH records the body. */
function stub(sub: Record<string, unknown>, patchRows = 1) {
  const patches: Array<{ url: string; body: any }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => Array(patchRows).fill({ id: SUB }) } as Response;
    }
    return { ok: true, json: async () => [sub] } as Response;
  }) as unknown as typeof fetch;
  return patches;
}

describe("AccountPauseService", () => {
  const svc = new AccountPauseService(config, notifications);

  it("pauses an active plan and moves the end date by the pause length", async () => {
    const patches = stub(row());
    const res = await svc.pause(USER, "plan", SUB, 30, undefined, NOW);
    expect(res.status).toBe("paused");
    expect(res.endsOn).toBe("2027-01-30");
    expect(res.pause).toEqual({ from: "2026-12-10", until: "2027-01-09", days: 30 });
    expect(res.pauseDaysLeft).toBe(60);
    expect(patches[0].url).toContain("status=eq.active");
    expect(patches[0].body.metadata).toMatchObject({ plan_name: "Gym", pause_days_used: 30, pause_period_start: "2026-12-01" });
  });

  it("refuses a length that is not offered", async () => {
    stub(row());
    await expect(svc.pause(USER, "plan", SUB, 45, undefined, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses someone else's subscription", async () => {
    stub(row({ user_id: "99999999-9999-9999-9999-999999999999" }));
    await expect(svc.pause(USER, "plan", SUB, 14, undefined, NOW)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a PayPal auto-renewing plan", async () => {
    stub(row({ auto_renew: true }));
    await expect(svc.pause(USER, "plan", SUB, 14, undefined, NOW)).rejects.toThrow(/PayPal/);
  });

  it("refuses an unpaid or ended plan", async () => {
    stub(row({ payment_status: "pending" }));
    await expect(svc.pause(USER, "plan", SUB, 14, undefined, NOW)).rejects.toBeInstanceOf(BadRequestException);
    stub(row({ end_date: "2026-12-09" }));
    await expect(svc.pause(USER, "plan", SUB, 14, undefined, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("caps pause days per paid period", async () => {
    stub(row({ metadata: { pause_period_start: "2026-12-01", pause_days_used: 60 } }));
    await expect(svc.pause(USER, "plan", SUB, 60, undefined, NOW)).rejects.toThrow(/30 pause days left/);
  });

  it("gives a renewed period a fresh allowance", () => {
    expect(pauseDaysUsed({ pause_period_start: "2026-11-01", pause_days_used: 90 }, "2026-12-01")).toBe(0);
  });

  it("refuses services that pause elsewhere", async () => {
    stub(row());
    await expect(svc.pause(USER, "cleaning", SUB, 14, undefined, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resuming early gives the unused days back", async () => {
    const patches = stub(row({
      status: "paused",
      end_date: "2027-01-30",
      metadata: { pause: { from: "2026-12-01", until: "2026-12-31", days: 30 }, pause_period_start: "2026-12-01", pause_days_used: 30 },
    }));
    const res = await svc.unpause(USER, "plan", SUB, undefined, NOW);
    // 21 unused days (10 Dec → 31 Dec) come off the end date and the allowance.
    expect(res.endsOn).toBe("2027-01-09");
    expect(res.pauseDaysLeft).toBe(81);
    expect(patches[0].body.status).toBe("active");
    expect(patches[0].body.metadata.pause).toBeUndefined();
  });

  it("leaves a pause set by the business alone", async () => {
    stub(row({ status: "paused", metadata: {} }));
    await expect(svc.unpause(USER, "plan", SUB, undefined, NOW)).rejects.toThrow(/paused by the business/);
  });

  it("reports a lost race instead of claiming success", async () => {
    stub(row(), 0);
    await expect(svc.pause(USER, "plan", SUB, 14, undefined, NOW)).rejects.toThrow(/changed in the meantime/);
  });

  it("date helpers", () => {
    expect(addDaysStr("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-12-10", "2026-12-31")).toBe(21);
    expect(withoutPause({ pause: { until: "x" }, a: 1 })).toEqual({ a: 1 });
  });
});
