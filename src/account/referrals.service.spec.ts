import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { ReferralsService } from "./referrals.service";

/**
 * Every rule in `claim` exists because the alternative pays somebody for
 * nothing, so each one gets a test. The reward itself is a database trigger and
 * is covered where it lives; here we only care that attribution refuses what it
 * should refuse.
 */

type Route = (url: string, init?: RequestInit) => unknown;

/** A fake PostgREST: match on the path, answer with rows. */
function stubSupabase(routes: Array<[RegExp, Route]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const [pattern, answer] of routes) {
      if (pattern.test(String(url))) {
        return { ok: true, text: async () => JSON.stringify(answer(String(url), init) ?? []) } as Response;
      }
    }
    return { ok: true, text: async () => "[]" } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const config = {
  get: (key: string) =>
    ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-key" } as Record<string, string>)[key],
} as ConfigService;

const REFERRER = "11111111-1111-1111-1111-111111111111";
const REFEREE  = "22222222-2222-2222-2222-222222222222";

const settingsOn = [
  { key: "referral_enabled", value: true },
  { key: "referral_reward_cents", value: 1000 },
  { key: "referral_welcome_cents", value: 1000 },
];

describe("ReferralsService.claim", () => {
  let service: ReferralsService;
  const realFetch = global.fetch;

  beforeEach(() => { service = new ReferralsService(config); });
  afterAll(() => { global.fetch = realFetch; });

  it("records the referral when the code is a stranger's and the account is new", async () => {
    const calls = stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?referral_code=eq\.ABC123/, () => [{ id: REFERRER }]],
      [/referrals\?referee_user_id/, () => []],
      [/payment_status=eq\.paid/, () => []],
    ]);

    await expect(service.claim(REFEREE, "abc123")).resolves.toEqual({ claimed: true });

    const write = calls.find((c) => c.init?.method === "POST");
    expect(write).toBeDefined();
    expect(JSON.parse(String(write!.init!.body))).toMatchObject({
      referrer_user_id: REFERRER,
      referee_user_id: REFEREE,
      // Lower case in, upper case stored — the code is spoken aloud and typed
      // by hand, so it cannot be case-sensitive.
      code: "ABC123",
      status: "pending",
    });
  });

  it("refuses a code nobody owns", async () => {
    stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?referral_code/, () => []],
    ]);
    await expect(service.claim(REFEREE, "ZZZZZZ")).resolves.toEqual({
      claimed: false, reason: "unknown-code",
    });
  });

  it("refuses your own code", async () => {
    stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?referral_code/, () => [{ id: REFEREE }]],
    ]);
    await expect(service.claim(REFEREE, "SELF01")).resolves.toEqual({
      claimed: false, reason: "self",
    });
  });

  it("refuses a second referral on the same account", async () => {
    stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?referral_code/, () => [{ id: REFERRER }]],
      [/referrals\?referee_user_id/, () => [{ id: "existing" }]],
    ]);
    await expect(service.claim(REFEREE, "ABC123")).resolves.toEqual({
      claimed: false, reason: "already-referred",
    });
  });

  it("refuses to back-attribute someone who has already bought", async () => {
    stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?referral_code/, () => [{ id: REFERRER }]],
      [/referrals\?referee_user_id/, () => []],
      [/food_subscriptions.*payment_status=eq\.paid/, () => [{ id: "an-order" }]],
    ]);
    await expect(service.claim(REFEREE, "ABC123")).resolves.toEqual({
      claimed: false, reason: "already-a-customer",
    });
  });

  it("does nothing at all while the programme is switched off", async () => {
    stubSupabase([[/global_settings/, () => [{ key: "referral_enabled", value: false }]]]);
    await expect(service.claim(REFEREE, "ABC123")).resolves.toEqual({
      claimed: false, reason: "disabled",
    });
  });

  it("rejects something that is not a code before it reaches the database", async () => {
    stubSupabase([[/global_settings/, () => settingsOn]]);
    await expect(service.claim(REFEREE, "not a code!")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ReferralsService.summary", () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  it("adds the ledger up and shows first names only", async () => {
    stubSupabase([
      [/global_settings/, () => settingsOn],
      [/users\?id=eq\./, () => [{ referral_code: "9C37UX" }]],
      [/referrals\?referrer_user_id/, () => [
        { referee_user_id: REFEREE, status: "qualified", created_at: "2026-09-01T00:00:00Z" },
      ]],
      [/user_credits/, () => [
        { amount_cents: 1000, reason: "referral_reward", note: null, created_at: "2026-09-02T00:00:00Z" },
        { amount_cents: -400, reason: "spend",           note: null, created_at: "2026-09-03T00:00:00Z" },
      ]],
      [/users\?id=in\./, () => [{ id: REFEREE, name: "Ana Maria Reyes", display_name: null }]],
    ]);

    const summary = await new ReferralsService(config).summary(REFERRER);

    expect(summary.code).toBe("9C37UX");
    expect(summary.balanceCents).toBe(600);   // the ledger, spend included
    expect(summary.earnedCents).toBe(1000);   // referral rewards only
    expect(summary.invited).toEqual([
      { name: "Ana", status: "qualified", joinedAt: "2026-09-01T00:00:00Z" },
    ]);
  });
});
