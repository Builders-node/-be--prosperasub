import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RefundsService } from "./refunds.service";

/**
 * A refund is the one admin action that sends money outward on the customer's
 * side, so every refusal it makes gets a test. The happy paths matter less
 * than the guards: refunding twice, or refunding more than was taken, is money
 * that does not come back.
 */

const config = {
  get: (k: string) =>
    ({ SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc" } as Record<string, string>)[k],
} as ConfigService;

type Handler = (url: string, init?: RequestInit) => unknown;

function stubRest(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) {
      if (re.test(String(url))) {
        return { ok: true, text: async () => JSON.stringify(fn(String(url), init) ?? []) } as Response;
      }
    }
    return { ok: true, text: async () => "[]" } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const paidOrder = (over: Record<string, unknown> = {}) => [{
  id: "order-1", user_id: "u1", price_cents: 5000,
  payment_status: "paid", payment_method: "paypal", payment_reference: "CAP123",
  ...over,
}];

describe("RefundsService", () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  const make = (paypal: any = { refundCapture: jest.fn() }) =>
    ({ service: new RefundsService(config, paypal), paypal });

  it("refuses an order type it does not know", async () => {
    const { service } = make();
    await expect(service.refund("users", "1", {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an order that is not there", async () => {
    stubRest([[/provider_subscriptions\?id=/, () => []]]);
    const { service } = make();
    await expect(service.refund("provider_subscriptions", "nope", {}))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to refund the same order twice", async () => {
    stubRest([[/provider_subscriptions\?id=/, () => paidOrder({ payment_status: "refunded" })]]);
    const { service } = make();
    await expect(service.refund("provider_subscriptions", "order-1", {}))
      .rejects.toThrow(/already been refunded/);
  });

  it("refuses an order that was never paid", async () => {
    stubRest([[/provider_subscriptions\?id=/, () => paidOrder({ payment_status: "pending" })]]);
    const { service } = make();
    await expect(service.refund("provider_subscriptions", "order-1", {}))
      .rejects.toThrow(/Only a paid order/);
  });

  it("refuses more than was taken", async () => {
    stubRest([[/provider_subscriptions\?id=/, () => paidOrder()]]);
    const { service } = make();
    await expect(service.refund("provider_subscriptions", "order-1", { amountCents: 9900 }))
      .rejects.toThrow(/more than was paid/);
  });

  it("sends a PayPal capture back and reports it as not manual", async () => {
    stubRest([[/provider_subscriptions\?id=/, () => paidOrder()]]);
    const paypal = { refundCapture: jest.fn().mockResolvedValue({ refunded: true, refund_id: "RF1", status: "COMPLETED" }) };
    const { service } = make(paypal);

    const res = await service.refund("provider_subscriptions", "order-1", { reason: "spoiled" });

    expect(paypal.refundCapture).toHaveBeenCalledWith("CAP123", 5000);
    expect(res).toMatchObject({ ok: true, amountCents: 5000, manual: false, providerRefundId: "RF1" });
  });

  it("records a Bitcoin refund as an obligation instead of pretending", async () => {
    // Bitcoin has no reverse and the platform never stored an address to send
    // to, so the only honest answer is "you still have to send this".
    stubRest([[/provider_subscriptions\?id=/, () => paidOrder({ payment_method: "onchain", payment_reference: "txid" })]]);
    const paypal = { refundCapture: jest.fn() };
    const { service } = make(paypal);

    const res = await service.refund("provider_subscriptions", "order-1", {});

    expect(paypal.refundCapture).not.toHaveBeenCalled();
    expect(res.manual).toBe(true);
    expect(res.note).toMatch(/cannot be sent back automatically/);
  });

  it("writes a NEGATIVE ledger row, because the ledger is a ledger", async () => {
    const calls = stubRest([[/provider_subscriptions\?id=/, () => paidOrder({ payment_method: "cash" })]]);
    const { service } = make();

    await service.refund("provider_subscriptions", "order-1", { amountCents: 2500, reason: "half" });

    const ledger = calls.find((c) => c.url.includes("/payments") && c.init?.method === "POST");
    expect(ledger).toBeDefined();
    expect(JSON.parse(String(ledger!.init!.body))).toMatchObject({
      amount_cents: -2500, status: "refunded",
    });
  });

  it("leaves a partly refunded order paid, and ends a fully refunded one", async () => {
    for (const [amount, expected] of [[2500, undefined], [5000, "refunded"]] as const) {
      const calls = stubRest([[/provider_subscriptions\?id=/, () => paidOrder({ payment_method: "cash" })]]);
      const { service } = make();
      await service.refund("provider_subscriptions", "order-1", { amountCents: amount });
      const patch = calls.find((c) => c.init?.method === "PATCH");
      const body = JSON.parse(String(patch!.init!.body));
      // A customer who got half back still has the other half.
      expect(body.payment_status).toBe(expected);
    }
  });
});
