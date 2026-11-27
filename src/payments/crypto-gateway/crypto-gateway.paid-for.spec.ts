import { CryptoGatewayService } from "./crypto-gateway.service";

/** paidFor(): the check a renewal uses — stricter than verify(). */
describe("CryptoGatewayService.paidFor", () => {
  const config = { get: (k: string) => ({ NOWPAYMENTS_API_KEY: "key", CRYPTO_GATEWAY: "nowpayments" } as any)[k] } as any;

  function make(session: { amount_cents: number | null } | null, payment: { payment_status: string; price_amount: number }) {
    const settlement = { sessionFor: jest.fn().mockResolvedValue(session) } as any;
    const svc = new CryptoGatewayService(config, {} as any, settlement);
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ payment_id: 42, ...payment }) }));
    return svc;
  }

  afterEach(() => { delete (global as any).fetch; });

  it("accepts a paid payment raised by us for at least the amount", async () => {
    const svc = make({ amount_cents: 8295 }, { payment_status: "finished", price_amount: 82.95 });
    await expect(svc.paidFor("42", 7900)).resolves.toEqual({ ok: true, status: "finished" });
  });

  it("refuses a payment this server never raised", async () => {
    const svc = make(null, { payment_status: "finished", price_amount: 82.95 });
    await expect(svc.paidFor("42", 7900)).resolves.toEqual({ ok: false, reason: "unknown_payment" });
  });

  it("refuses a cheaper payment presented for a dearer renewal", async () => {
    const svc = make({ amount_cents: 500 }, { payment_status: "finished", price_amount: 5 });
    await expect(svc.paidFor("42", 7900)).resolves.toEqual({ ok: false, reason: "amount_too_low" });
  });

  it("refuses an underpayment", async () => {
    const svc = make({ amount_cents: 7900 }, { payment_status: "partially_paid", price_amount: 79 });
    await expect(svc.paidFor("42", 7900)).resolves.toMatchObject({ ok: false });
  });
});
