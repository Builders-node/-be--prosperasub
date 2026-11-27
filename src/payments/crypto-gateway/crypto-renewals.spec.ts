import { CryptoGatewayService } from "./crypto-gateway.service";
import { decodeRenewalOrderId, encodeRenewalOrderId, renewalIdempotencyKey } from "./crypto-renewals";

describe("crypto renewal order ids", () => {
  const sub = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

  it("round-trips what a renewal needs", () => {
    const id = encodeRenewalOrderId({ service: "plan", subscriptionId: sub, amountCents: 7900, surchargeCents: 237 }, "abc123");
    expect(id).toBe(`ren:plan:${sub}:7900:237:abc123`);
    expect(decodeRenewalOrderId(id)).toEqual({ service: "plan", subscriptionId: sub, amountCents: 7900, surchargeCents: 237 });
  });

  it("ignores ordinary order ids and malformed ones", () => {
    expect(decodeRenewalOrderId("es-lz3k9abcd")).toBeNull();
    expect(decodeRenewalOrderId(null)).toBeNull();
    expect(decodeRenewalOrderId(`ren:boats:${sub}:7900:0:x`)).toBeNull();
    expect(decodeRenewalOrderId(`ren:plan:${sub}:0:0:x`)).toBeNull();
    expect(decodeRenewalOrderId(`ren:plan:bad/id:7900:0:x`)).toBeNull();
  });

  it("derives one stable, UUID-shaped key per payment", () => {
    const k = renewalIdempotencyKey("5077125051");
    expect(k).toBe(renewalIdempotencyKey("5077125051"));
    expect(k).not.toBe(renewalIdempotencyKey("5077125052"));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("CryptoGatewayService — server-side renewals", () => {
  const config = { get: (k: string) => ({ NOWPAYMENTS_API_KEY: "key", CRYPTO_GATEWAY: "nowpayments" } as any)[k] } as any;
  const sub = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

  function make() {
    const settlement = {
      markPaidByReference: jest.fn().mockResolvedValue(false),
      sessionFor: jest.fn().mockResolvedValue({ amount_cents: 8137 }),
      unsettledRenewalRefs: jest.fn().mockResolvedValue([]),
    } as any;
    const svc = new CryptoGatewayService(config, {} as any, settlement);
    return { svc, settlement };
  }

  const paid = (orderId: string) => ({
    paymentId: "42", state: "paid" as const, rawStatus: "finished", payAddress: "x", payExtraId: null,
    payAmount: "81.37", payCurrency: "usdttrc20", priceCents: 8137, expiresAt: null, orderId,
  });

  it("hands a paid renewal to the service that owns the subscription", async () => {
    const { svc } = make();
    const handler = jest.fn().mockResolvedValue({ ok: true, idempotent: false });
    svc.registerRenewalHandler("plan", handler);
    const orderId = encodeRenewalOrderId({ service: "plan", subscriptionId: sub, amountCents: 7900, surchargeCents: 237 }, "n");
    await expect(svc.settle("42", "viaWebhook", paid(orderId))).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith({ service: "plan", subscriptionId: sub, amountCents: 7900, surchargeCents: 237 }, "42");
  });

  it("reports nothing new when the browser already renewed it", async () => {
    const { svc } = make();
    svc.registerRenewalHandler("plan", jest.fn().mockResolvedValue({ ok: true, idempotent: true }));
    const orderId = encodeRenewalOrderId({ service: "plan", subscriptionId: sub, amountCents: 7900, surchargeCents: 0 }, "n");
    await expect(svc.settle("42", "viaWebhook", paid(orderId))).resolves.toBe(false);
  });

  it("never throws at the gateway when a renewal is refused", async () => {
    const { svc } = make();
    svc.registerRenewalHandler("food", jest.fn().mockRejectedValue(new Error("Cancelled subscriptions cannot be renewed.")));
    const orderId = encodeRenewalOrderId({ service: "food", subscriptionId: sub, amountCents: 7900, surchargeCents: 0 }, "n");
    await expect(svc.settle("42", "viaWebhook", paid(orderId))).resolves.toBe(false);
  });

  it("leaves ordinary orders to the order settlement", async () => {
    const { svc, settlement } = make();
    const handler = jest.fn();
    svc.registerRenewalHandler("plan", handler);
    settlement.markPaidByReference.mockResolvedValue(true);
    await expect(svc.settle("42", "viaWebhook", paid("es-abc"))).resolves.toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
