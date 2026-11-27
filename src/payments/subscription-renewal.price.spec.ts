import { ForbiddenException } from "@nestjs/common";
import { SubscriptionRenewalService, paypalCapturedCents } from "./subscription-renewal.service";

/**
 * A renewal's amount is the server's price, and the payment must cover it —
 * the browser's `amount_cents` is no longer taken on trust.
 */
describe("SubscriptionRenewalService — renewal price", () => {
  const config = { get: (k: string) => ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "k" } as any)[k] } as any;

  function make(deps: { blink?: any; paypal?: any; settlement?: any } = {}) {
    return new SubscriptionRenewalService(deps.blink ?? {}, deps.paypal ?? {}, config, {} as any, deps.settlement ?? {});
  }

  function mockPlans(rows: unknown[]) {
    const urls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => rows, text: async () => "" };
    });
    return urls;
  }

  afterEach(() => { delete (global as any).fetch; });

  describe("renewalPriceCents", () => {
    it("is plan price × term for a flat plan", async () => {
      const urls = mockPlans([{ price_cents: 7900, pricing_mode: "flat" }]);
      await expect(make().renewalPriceCents({ planId: "p1", periods: 3, people: 4 })).resolves.toBe(23700);
      expect(urls[0]).toContain("/provider_plans?id=eq.p1");
    });

    it("counts people only on a per-person plan", async () => {
      mockPlans([{ price_cents: 2500, pricing_mode: "per_person" }]);
      await expect(make().renewalPriceCents({ planId: "p1", periods: 1, people: 3 })).resolves.toBe(7500);
    });

    it("finds a legacy food / cleaning plan by its source id", async () => {
      const urls = mockPlans([{ price_cents: 4000, pricing_mode: "flat" }]);
      await expect(make().renewalPriceCents({ sourceKey: "food", sourcePlanId: "m1", periods: 4 })).resolves.toBe(16000);
      expect(urls[0]).toContain("source_service_key=eq.food&source_plan_id=eq.m1");
    });

    it("is null when the plan is gone", async () => {
      mockPlans([]);
      await expect(make().renewalPriceCents({ planId: "gone", periods: 1 })).resolves.toBeNull();
    });
  });

  describe("assertCoversPrice", () => {
    it("accepts the price, and a cent of rounding", () => {
      expect(() => make().assertCoversPrice(7900, 7900)).not.toThrow();
      expect(() => make().assertCoversPrice(7899, 7900)).not.toThrow();
    });

    it("refuses a claim below the price", () => {
      expect(() => make().assertCoversPrice(1, 7900)).toThrow(ForbiddenException);
    });

    it("refuses when there is no price to check against", () => {
      expect(() => make().assertCoversPrice(7900, null)).toThrow(ForbiddenException);
    });
  });

  describe("verifyPayment checks the amount actually paid", () => {
    it("refuses a paid Lightning invoice raised for less than the renewal", async () => {
      const svc = make({
        blink: { getPaymentStatus: jest.fn().mockResolvedValue({ paid: true, status: "PAID" }) },
        settlement: { sessionFor: jest.fn().mockResolvedValue({ amount_cents: 1 }) },
      });
      await expect(svc.verifyPayment({ method: "lightning", reference: "h", amountCents: 7900 })).rejects.toThrow("below the renewal amount");
    });

    it("refuses a Lightning invoice this server never raised", async () => {
      const svc = make({
        blink: { getPaymentStatus: jest.fn().mockResolvedValue({ paid: true, status: "PAID" }) },
        settlement: { sessionFor: jest.fn().mockResolvedValue(null) },
      });
      await expect(svc.verifyPayment({ method: "lightning", reference: "h", amountCents: 7900 })).rejects.toThrow("not raised by this server");
    });

    it("accepts a Lightning invoice for the renewal amount", async () => {
      const svc = make({
        blink: { getPaymentStatus: jest.fn().mockResolvedValue({ paid: true, status: "PAID" }) },
        settlement: { sessionFor: jest.fn().mockResolvedValue({ amount_cents: 8137 }) },
      });
      await expect(svc.verifyPayment({ method: "lightning", reference: "h", amountCents: 7900 })).resolves.toEqual({ providerStatus: "PAID" });
    });

    it("refuses a PayPal capture smaller than the renewal", async () => {
      const order = { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: { value: "1.00" } }] } }] };
      const svc = make({
        paypal: { captureOrder: jest.fn().mockResolvedValue({ paid: true, status: "COMPLETED" }), getOrder: jest.fn().mockResolvedValue(order) },
      });
      await expect(svc.verifyPayment({ method: "paypal", reference: "o", amountCents: 7900 })).rejects.toThrow("below the renewal amount");
    });
  });

  it("sums only completed PayPal captures", () => {
    expect(paypalCapturedCents({
      purchase_units: [{ payments: { captures: [
        { status: "COMPLETED", amount: { value: "79.00" } },
        { status: "DECLINED", amount: { value: "79.00" } },
      ] } }],
    })).toBe(7900);
    expect(paypalCapturedCents(null)).toBe(0);
  });
});
