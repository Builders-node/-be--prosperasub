import { ForbiddenException } from "@nestjs/common";
import { SubscriptionRenewalService } from "./subscription-renewal.service";

/**
 * Crypto-gateway renewals, and the "one payment renews one period" rule that
 * every method now goes through.
 */
describe("SubscriptionRenewalService — crypto renewals", () => {
  const config = { get: (k: string) => ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "k" } as any)[k] } as any;

  function make(paidFor: jest.Mock) {
    return new SubscriptionRenewalService({} as any, {} as any, config, { paidFor } as any);
  }

  /** Answers PostgREST GETs from a table → rows map; records every URL. */
  function mockRest(tables: Record<string, unknown[]>) {
    const urls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      const table = url.split("/rest/v1/")[1].split("?")[0];
      return { ok: true, status: 200, json: async () => tables[table] ?? [], text: async () => "" };
    });
    return urls;
  }

  afterEach(() => { delete (global as any).fetch; });

  it("accepts a crypto payment the gateway confirms for the renewal amount", async () => {
    const paidFor = jest.fn().mockResolvedValue({ ok: true, status: "finished" });
    const svc = make(paidFor);
    await expect(svc.verifyPayment({ method: "crypto_gateway", reference: "5077125051", amountCents: 7900 }))
      .resolves.toEqual({ providerStatus: "finished" });
    expect(paidFor).toHaveBeenCalledWith("5077125051", 7900);
  });

  it("refuses a crypto payment the gateway does not accept", async () => {
    const svc = make(jest.fn().mockResolvedValue({ ok: false, reason: "amount_too_low" }));
    await expect(svc.verifyPayment({ method: "crypto_gateway", reference: "1", amountCents: 7900 }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a payment that already renewed another subscription", async () => {
    mockRest({ subscription_renewals: [{ subscription_id: "other-sub", idempotency_key: "k1" }] });
    const svc = make(jest.fn());
    await expect(svc.assertReferenceUnused({ subscriptionId: "sub", idempotencyKey: "k2", reference: "ref" }))
      .rejects.toThrow("already been used");
  });

  it("refuses the payment that bought the order in the first place", async () => {
    mockRest({ subscription_renewals: [], provider_subscriptions: [{ id: "sub" }] });
    const svc = make(jest.fn());
    await expect(svc.assertReferenceUnused({ subscriptionId: "sub", idempotencyKey: "k", reference: "ref" }))
      .rejects.toThrow("already paid for an order");
  });

  it("lets a retry of the same renewal through (idempotency)", async () => {
    // After the first success the subscription row carries the reference too —
    // the retry must not trip over its own write.
    const urls = mockRest({
      subscription_renewals: [{ subscription_id: "sub", idempotency_key: "k" }],
      provider_subscriptions: [{ id: "sub" }],
    });
    const svc = make(jest.fn());
    await expect(svc.assertReferenceUnused({ subscriptionId: "sub", idempotencyKey: "k", reference: "ref" })).resolves.toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it("allows a fresh payment", async () => {
    mockRest({});
    const svc = make(jest.fn());
    await expect(svc.assertReferenceUnused({ subscriptionId: "sub", idempotencyKey: "k", reference: "new" })).resolves.toBeUndefined();
  });
});
